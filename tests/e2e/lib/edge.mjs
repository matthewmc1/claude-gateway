// Helpers for L6 (the enterprise edge on a laptop): boots the REAL gateway binary behind the ILB emulator (https://gateway.localhost),
// the budget app in iap mode behind the IAP emulator (http://app.localhost), a local IdP, and drives them with node http(s) and a real
// headless Chrome over the DevTools protocol. Zero dependencies. Uses only ports 19270-19289 (the standalone Postgres is 19260).
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { E } from './env.mjs';
import { ROOT, writeFakeAdc } from './config.mjs';
import { sleep } from './gw.mjs';
import { startIapEmulator } from '../../../scripts/edge/iap-emulator.mjs';
import { startIlbEmulator } from '../../../scripts/edge/ilb-emulator.mjs';
import { startIdpEmulator } from '../../../scripts/edge/idp-emulator.mjs';
import { DEFAULT_AUDIENCE, edgeAppEnv, makeEdgeSecrets, renderEdgeGatewayYaml } from '../../../scripts/edge/prepare.mjs';

export const EP = { app: 19270, idp: 19271, gateway: 19272, gwInternal: 19273, appInternal: 19274, evil: 19275, chrome: 19276, iapSelf: 19280, echoIap: 19281, ilbSelf: 19282, ilbDeny: 19283, echoIlb: 19284 };
export const APP_ORIGIN = `http://app.localhost:${EP.app}`, GW_URL = `https://gateway.localhost:${EP.gateway}`;
export const ADMIN = 'ada@example.com', VIEWER = 'bob@example.com', OUTSIDER = 'mallory@example.com';

// *.localhost is loopback by RFC 6761, but not every resolver says so: pin it so the tests never depend on the OS.
const lookup = (host, opts, cb) => {
  const all = typeof opts === 'object' && opts.all;
  if (host === 'localhost' || host.endsWith('.localhost')) return process.nextTick(cb, null, ...(all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]));
  return dns.lookup(host, opts, cb);
};

// One request, no redirects followed, cookies handled by the caller. `ca` pins the trust anchor (https); `headers.host` may be overridden.
export function req(url, { method = 'GET', headers = {}, body, ca, timeoutMs = 20000 } = {}) {
  const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
  return new Promise((ok, no) => {
    const r = mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, lookup, ca, headers: { connection: 'close', ...headers }, timeout: timeoutMs }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = t ? JSON.parse(t) : null; } catch { /* not JSON */ } ok({ status: res.statusCode, headers: res.headers, text: t, json, cookies: [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]) }); });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', no);
    r.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
export const form = (o) => new URLSearchParams(o).toString();

// ---- reference verification of an IAP token (independent of the app's own implementation) ----
export function verifyIap(token, { jwks, aud, now = Math.floor(Date.now() / 1000) }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const [h, p, s] = parts;
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); } catch { throw new Error('undecodable'); }
  if (header.alg !== 'ES256') throw new Error('alg');
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('signature');
  if (claims.iss !== 'https://cloud.google.com/iap') throw new Error('iss');
  if (claims.aud !== aud) throw new Error('aud');
  if (!(claims.exp > now - 30)) throw new Error('expired');
  if (!(claims.iat <= now + 30)) throw new Error('iat');
  if (claims.exp - claims.iat > 600 + 60) throw new Error('lifetime');
  if (!claims.email) throw new Error('email');
  return claims;
}

// ---- a recording upstream, for testing the emulators on their own ----
export function startEcho(port) {
  const seen = [];
  const server = http.createServer((rq, rs) => { let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => { const rec = { method: rq.method, url: rq.url, headers: rq.headers, body: b, peer: rq.socket.remoteAddress }; seen.push(rec); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(rec)); }); });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) })));
}

// ---- certificates (the real script) ----
export function makeCerts(dir) {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'edge', 'make-certs.sh'), dir], { stdio: 'pipe' });
  const fp = fs.readFileSync(path.join(dir, 'fingerprints.txt'), 'utf8');
  return { dir, ca: fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), spki: /leaf spki b64:\s+(\S+)/.exec(fp)[1] };
}

// ---- the whole edge ----
// Everything is started by this function and stopped by close(); only those processes are ever signalled.
export async function bootEdge({ dataDir, db = 'gateway_edge', admins = [ADMIN], users = [ADMIN, VIEWER, 'alice@example.com'], audience = DEFAULT_AUDIENCE, appExtraEnv = {}, ilbAllowCidrs = [] } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secrets = makeEdgeSecrets(admins), certs = makeCerts(path.join(dataDir, 'certs'));
  const children = [], emus = [];
  const stopAll = async () => { for (const c of children) if (c.exitCode === null) { c.kill('SIGTERM'); await Promise.race([new Promise((r) => c.once('exit', r)), sleep(5000).then(() => c.kill('SIGKILL'))]); } for (const e of emus) await e.close(); };
  try {
    const idp = await startIdpEmulator({ port: EP.idp, users, redirectOrigins: [GW_URL], quiet: true }); emus.push(idp);
    // gateway: the real binary, plain http on loopback, public_url = the https load-balancer URL
    const yaml = path.join(dataDir, 'gateway.yaml'), errPath = path.join(dataDir, 'gateway.err'), home = path.join(dataDir, 'home-gw');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(yaml, renderEdgeGatewayYaml({ listenPort: EP.gwInternal, publicUrl: GW_URL, idpPort: EP.idp, pgUrl: `postgres://postgres:${E.pgPassword}@127.0.0.1:${E.pgPort}/${db}`, secrets }), { mode: 0o600 });
    const err = fs.openSync(errPath, 'a');
    const gw = spawn('claude', ['gateway', '--config', yaml], { stdio: ['ignore', 'ignore', err], env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'cc'), CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1', CLAUDE_GATEWAY_LOG_LEVEL: 'info', GOOGLE_APPLICATION_CREDENTIALS: writeFakeAdc(dataDir, EP.idp) } });
    fs.closeSync(err); children.push(gw);
    const ilb = await startIlbEmulator({ port: EP.gateway, upstream: `http://127.0.0.1:${EP.gwInternal}`, certDir: certs.dir, allowCidrs: ilbAllowCidrs, quiet: true }); emus.push(ilb);
    const iap = await startIapEmulator({ port: EP.app, upstream: `http://127.0.0.1:${EP.appInternal}`, audience, users, quiet: true }); emus.push(iap);
    // the app: the real server in iap mode, on its own port (reachable directly, to prove that bypassing IAP does not work)
    const appEnv = edgeAppEnv({ appInternalPort: EP.appInternal, appOrigin: APP_ORIGIN, gatewayUrl: GW_URL, caPem: certs.ca, iapKeysUrl: `http://127.0.0.1:${EP.app}/.well-known/iap-keys.json`, audience, secrets, admins, dataDir: path.join(dataDir, 'app') });
    const appOut = path.join(dataDir, 'app.log'), ao = fs.openSync(appOut, 'a');
    const app = spawn(process.execPath, [path.join(ROOT, 'api', 'server.mjs')], { cwd: ROOT, stdio: ['ignore', ao, ao], env: { PATH: process.env.PATH, ...appEnv, ...appExtraEnv } });
    fs.closeSync(ao); children.push(app);
    const ready = async (what, fn, ms = 25000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch { /* not yet */ } await sleep(150); }
      throw new Error(`${what} did not become ready; app log: ${fs.readFileSync(appOut, 'utf8').slice(-600)}; gateway log: ${fs.readFileSync(errPath, 'utf8').slice(-400)}`);
    };
    await ready('gateway behind the ILB emulator', async () => (await req(GW_URL + '/readyz', { ca: certs.ca })).status === 200);
    await ready('app', async () => (await req(`http://127.0.0.1:${EP.appInternal}/healthz`)).status === 200);
    const gwAdmin = (method, p, { key = secrets.keys.read, body } = {}) => req(GW_URL + '/v1/organizations/spend_limits' + p, { method, ca: certs.ca, headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
    // signed-in browser-ish client for the IAP emulator: keeps its cookie, sends same-origin headers on writes
    const person = async (email) => {
      const r = await req(APP_ORIGIN + '/_iap/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_ORIGIN }, body: form({ email, next: '/' }) });
      if (r.status !== 302 || !r.cookies.length) throw new Error(`sign-in as ${email} failed: ${r.status} ${r.text.slice(0, 120)}`);
      const cookie = r.cookies.join('; ');
      const call = (method, p, { body, headers = {}, same = true } = {}) => req(APP_ORIGIN + p, { method, headers: { cookie, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(same && method !== 'GET' ? { origin: APP_ORIGIN, 'x-app-csrf': '1', 'sec-fetch-site': 'same-origin' } : {}), ...headers }, body });
      return { email, cookie, call };
    };
    return {
      secrets, certs, idp, ilb, iap, audience, ca: certs.ca, gwAdmin, person, appLog: () => fs.readFileSync(appOut, 'utf8'), gwLog: () => fs.readFileSync(errPath, 'utf8'),
      direct: (method, p, o = {}) => req(`http://127.0.0.1:${EP.appInternal}${p}`, { method, ...o }),
      close: stopAll,
    };
  } catch (e) { await stopAll(); throw e; }
}

// Real device-code sign-in through the load-balancer emulator and the local IdP (the way Claude Code's /login does it).
export async function edgeDeviceLogin(edge, email) {
  const g = (p, o = {}) => req(GW_URL + p, { ca: edge.ca, ...o });
  const d = (await g('/oauth/device_authorization', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ surface: 'claude_code' }) })).json;
  const v = await g('/device', { method: 'POST', headers: { origin: GW_URL, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: form({ user_code: d.user_code }) });
  const cookie = (v.cookies || []).join('; '), loc = new URL(v.headers.location);
  if (loc.origin !== `http://127.0.0.1:${EP.idp}`) throw new Error('device flow did not redirect to the local IdP: ' + loc.origin);
  const redirectUri = loc.searchParams.get('redirect_uri');
  loc.searchParams.set('e2e_email', email);
  const a = await req(loc.toString());
  const back = await g(new URL(a.headers.location).pathname + new URL(a.headers.location).search, { headers: { cookie } });
  const t = (await g('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code }) })).json;
  return { token: t.access_token, redirectUri, callbackStatus: back.status, device: d };
}

// ---- headless Chrome over the DevTools protocol (a ~60 line WebSocket client; node 20 has no global WebSocket) ----
export function findChrome() {
  const cands = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of cands) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    try { return execFileSync('which', [c], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return null;
}

function wsConnect(url) {
  const u = new URL(url), key = crypto.randomBytes(16).toString('base64');
  return new Promise((ok, no) => {
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' } });
    r.on('error', no);
    r.on('upgrade', (_res, socket, head) => {
      let buf = Buffer.from(head), frag = [];
      const ws = { onmessage: null, send(text) {
        const p = Buffer.from(text), n = p.length, mask = crypto.randomBytes(4);
        const h = n < 126 ? Buffer.from([0x81, 0x80 | n]) : n < 65536 ? Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), Buffer.alloc(8)]);
        if (n >= 65536) h.writeBigUInt64BE(BigInt(n), 2);
        socket.write(Buffer.concat([h, mask, p.map((b, i) => b ^ mask[i % 4])]));
      }, close() { socket.destroy(); } };
      const pump = () => {
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 127, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const op = buf[0] & 15, fin = buf[0] & 128, payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          if (op === 8) return socket.destroy();
          if (op === 9) continue;
          frag.push(payload);
          if (fin) { const m = Buffer.concat(frag).toString('utf8'); frag = []; ws.onmessage?.(m); }
        }
      };
      socket.on('data', (c) => { buf = Buffer.concat([buf, c]); pump(); });
      socket.on('error', () => {});
      pump(); ok(ws);
    });
    r.end();
  });
}

export async function launchChrome({ tmp, spki }) {
  const bin = findChrome();
  if (!bin) return null;
  const profile = fs.mkdtempSync(path.join(tmp, 'chrome-'));
  const child = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${EP.chrome}`,
    ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []), 'about:blank'], { stdio: 'ignore' });
  const t0 = Date.now();
  for (;;) {
    try { if ((await req(`http://127.0.0.1:${EP.chrome}/json/version`, { timeoutMs: 1000 })).status === 200) break; } catch { /* starting */ }
    if (Date.now() - t0 > 20000) { child.kill('SIGKILL'); throw new Error('chrome did not start'); }
    await sleep(200);
  }
  let seq = 0;
  // a fresh tab with its own event log: `page.log` collects console errors, failed loads and HTTP >= 400 answers
  const newPage = async () => {
    const t = (await req(`http://127.0.0.1:${EP.chrome}/json/new?about:blank`, { method: 'PUT' })).json;
    const ws = await wsConnect(t.webSocketDebuggerUrl), waiters = new Map(), listeners = [];
    const page = { log: { console: [], failed: [], http: [], requests: [] } };
    ws.onmessage = (m) => {
      const j = JSON.parse(m);
      if (j.id && waiters.has(j.id)) { const [ok, no] = waiters.get(j.id); waiters.delete(j.id); return j.error ? no(new Error(j.error.message)) : ok(j.result); }
      listeners.forEach((l) => l(j));
      if (j.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(j.params.type)) page.log.console.push(j.params.args.map((a) => a.value ?? a.description).join(' '));
      if (j.method === 'Runtime.exceptionThrown') page.log.console.push('exception: ' + (j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text));
      if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error') page.log.console.push(j.params.entry.text + ' ' + (j.params.entry.url || ''));
      if (j.method === 'Network.loadingFailed' && !j.params.canceled) page.log.failed.push(j.params.errorText + (j.params.blockedReason ? ` (${j.params.blockedReason})` : ''));
      if (j.method === 'Network.requestWillBeSent') page.log.requests.push({ id: j.params.requestId, method: j.params.request.method, url: j.params.request.url });
      if (j.method === 'Network.responseReceived' && j.params.response.status >= 400) page.log.http.push({ status: j.params.response.status, url: j.params.response.url });
    };
    const send = (method, params = {}) => new Promise((ok, no) => { const id = ++seq; waiters.set(id, [ok, no]); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (waiters.delete(id)) no(new Error('cdp timeout: ' + method)); }, 30000); });
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await send(m);
    Object.assign(page, {
      send,
      async goto(url, { settleMs = 600 } = {}) { const loaded = new Promise((r) => listeners.push((j) => j.method === 'Page.loadEventFired' && r())); await send('Page.navigate', { url }); await Promise.race([loaded, sleep(15000)]); await sleep(settleMs); },
      async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
      async until(expr, ms = 15000) { const t1 = Date.now(); for (;;) { try { const v = await page.eval(expr); if (v) return v; } catch { /* page navigating */ } if (Date.now() - t1 > ms) throw new Error('timed out waiting for: ' + expr); await sleep(150); } },
      url: () => page.eval('location.href'),
      close: () => { ws.close(); req(`http://127.0.0.1:${EP.chrome}/json/close/${t.id}`).catch(() => {}); },
    });
    return page;
  };
  return { bin, newPage, close: async () => { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000).then(() => child.kill('SIGKILL'))]); fs.rmSync(profile, { recursive: true, force: true }); } };
}

// a tiny page on a foreign origin (http://evil.localhost) used to attempt cross-site writes from a real browser
export function startEvilSite() {
  const server = http.createServer((_rq, rs) => { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<!doctype html><title>evil</title><p>foreign origin</p>'); });
  return new Promise((ok) => server.listen(EP.evil, '127.0.0.1', () => ok({ origin: `http://evil.localhost:${EP.evil}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) })));
}
