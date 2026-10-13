// Helpers for talking to the real gateway: sessions, inference, raw admin calls, the stderr log, and extra gateway processes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { E } from './env.mjs';
import { PORTS, renderGatewayYaml } from './config.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
export const unique = (p) => `${p}-${crypto.randomBytes(3).toString('hex')}`;

// A gateway session, minted the way the gateway does: HS256 JWT signed with session.jwt_secret (claims verified against /oauth/token output).
export function mintSession({ sub, email, name = null, url = E.gwUrl, secret = E.jwt, ttlSec = 3600, aud = 'claude-gateway' }) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000), h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ sub, email, name: name ?? email.split('@')[0], aud, iat: now, exp: now + ttlSec, iss: url });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

async function jsonFetch(url, init = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...init });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}
export const messages = (token, { model = MODELS.sonnet, url = E.gwUrl, body } = {}) => jsonFetch(url + '/v1/messages', {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(body || { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});
export const adminCall = (method, p, { key = E.keys.read, body, url = E.gwUrl } = {}) => jsonFetch(url + '/v1/organizations/spend_limits' + p, {
  method, headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
export const wget = (p, { url = E.gwUrl, token } = {}) => jsonFetch(url + p, token ? { headers: { authorization: 'Bearer ' + token } } : {});

// Make the gateway "know" a user (it only lists principals it has seen) by sending one canned request.
// The listing is eventually consistent (the spend ledger is written asynchronously, about a second after a process start), so wait for it.
export async function listedSubs({ url = E.gwUrl } = {}) {
  const seen = new Set(); let page = '';
  for (let i = 0; i < 50; i++) {
    const r = await adminCall('GET', '/effective?period%5B%5D=weekly&limit=1000' + page, { url });
    for (const row of r.json?.data || []) seen.add(row.scope.user_id);
    if (!r.json?.next_page) break;
    page = '&page=' + encodeURIComponent(r.json.next_page);
  }
  return seen;
}
export async function waitListed(subs, { url = E.gwUrl, ms = 10000 } = {}) {
  const t0 = Date.now(); let missing = [...subs];
  while (Date.now() - t0 < ms) {
    const have = await listedSubs({ url }); missing = missing.filter((s) => !have.has(s));
    if (!missing.length) return Date.now() - t0;
    await sleep(100);
  }
  throw new Error(`gateway never listed ${missing.length} user(s), e.g. ${missing[0]}`);
}
export async function introduce(user, token = mintSession(user), { url = E.gwUrl, wait = true } = {}) {
  const r = await messages(token, { url });
  if (r.status !== 200) throw new Error(`could not introduce ${user.sub}: ${r.status} ${r.text.slice(0, 120)}`);
  if (wait) await waitListed([user.sub], { url });
  return token;
}

// Remove every spend limit so each suite starts from a known state (the audit trail of course stays).
export async function resetLimits({ url = E.gwUrl } = {}) {
  for (let i = 0; i < 50; i++) {
    const r = await adminCall('GET', '?limit=1000', { url });
    if (!r.json?.data?.length) return;
    await Promise.all(r.json.data.map((l) => adminCall('DELETE', '/' + l.id, { key: E.keys.system, url })));
  }
  throw new Error('could not clear spend limits');
}

// The gateway's stderr: JSON event lines and the plain "[gateway] ..." text lines.
export const logSize = (file = E.gwLog) => { try { return fs.statSync(file).size; } catch { return 0; } };
export function logSince(offset = 0, file = E.gwLog) {
  const buf = fs.readFileSync(file); const text = buf.subarray(offset).toString('utf8');
  return text.split('\n').filter(Boolean);
}
export const jsonEvents = (lines) => lines.filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Real device-code login: /oauth/device_authorization -> /device (approve) -> fake OIDC -> /oauth/callback -> /oauth/token. Returns the access token.
export async function deviceLogin({ sub, email, name, url = E.gwUrl, oidcPort = E.oidcPort }) {
  const form = (o) => new URLSearchParams(o);
  const d = await (await fetch(url + '/oauth/device_authorization', { method: 'POST', body: form({ surface: 'claude_code' }) })).json();
  const v = await fetch(url + '/device', { method: 'POST', redirect: 'manual', headers: { origin: url, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: form({ user_code: d.user_code }) });
  const cookie = (v.headers.get('set-cookie') || '').split(';')[0];
  const loc = new URL(v.headers.get('location'));
  if (loc.port !== String(oidcPort)) throw new Error('device flow did not redirect to the fake OIDC issuer');
  loc.searchParams.set('e2e_sub', sub); loc.searchParams.set('e2e_email', email); loc.searchParams.set('e2e_name', name || email);
  const a = await fetch(loc, { redirect: 'manual' });
  await fetch(a.headers.get('location'), { redirect: 'manual', headers: { cookie } });
  const t = await (await fetch(url + '/oauth/token', { method: 'POST', body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code }) })).json();
  if (!t.access_token) throw new Error('device login failed: ' + JSON.stringify(t).slice(0, 120));
  return t.access_token;
}

// An additional, independent gateway process (own port and database) for tests that restart or stop it.
export function gatewayProcess({ name, port = PORTS.opsGateway, db = 'gateway_ops', secrets, loadTest = true, extraEnv = {} }) {
  const yamlPath = path.join(E.tmp, `gateway-${name}.yaml`), errPath = path.join(E.tmp, `gateway-${name}.err`);
  fs.writeFileSync(yamlPath, renderGatewayYaml({ port, oidcPort: E.oidcPort, pgPort: E.pgPort, pgPassword: E.pgPassword, db, secrets, loadTest }), { mode: 0o600 });
  let child = null;
  const url = `http://127.0.0.1:${port}`;
  const api = {
    url, errPath, port,
    get running() { return !!child && child.exitCode === null; },
    start() {
      const home = path.join(E.tmp, 'home-' + name); fs.mkdirSync(home, { recursive: true });
      const err = fs.openSync(errPath, 'a');
      child = spawn('claude', ['gateway', '--config', yamlPath], {
        stdio: ['ignore', 'ignore', err],
        env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'cc'), CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1', CLAUDE_GATEWAY_LOG_LEVEL: 'info', GOOGLE_APPLICATION_CREDENTIALS: E.fakeAdc, ...extraEnv },
      });
      fs.closeSync(err);
      return api.waitReady();
    },
    async waitReady(timeoutMs = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        try { const r = await fetch(url + '/readyz', { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* not up yet */ }
        await sleep(150);
      }
      throw new Error(`gateway ${name} did not become ready: ${fs.readFileSync(errPath, 'utf8').slice(-400)}`);
    },
    async stop() {
      if (!child || child.exitCode !== null) return;
      const c = child; const done = new Promise((r) => c.once('exit', r));
      c.kill('SIGTERM');
      await Promise.race([done, sleep(5000).then(() => c.kill('SIGKILL'))]);
      await done;
    },
  };
  return api;
}
export const secretsFromEnv = () => ({ jwt: E.jwt, oidcClientSecret: E.oidcClientSecret, keys: E.keys });
