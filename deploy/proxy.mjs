// Local authenticating proxy for a private Cloud Run service: localhost:<port> -> https://<service>.run.app
//
//   node deploy/proxy.mjs <service-url> <local-port>      (normally started by deploy/proxy.sh)
//
// Adds your Google identity token (from `gcloud auth print-identity-token`) in X-Serverless-Authorization,
// which Cloud Run checks and strips before the request reaches the container. The client's own Authorization
// header (the gateway session token Claude Code sends) is passed through untouched, which is why this is used
// instead of `gcloud run services proxy`. Binds to loopback only. Responses stream (SSE works). No dependencies.
//
// Because every forwarded request carries YOUR Google identity, the proxy is strict about who may use it:
//   * the Host header must be exactly localhost:<port> or 127.0.0.1:<port> (DNS-rebinding guard);
//   * a request with an Origin header is refused unless it is exactly http://localhost:<port> or http://127.0.0.1:<port>,
//     and Sec-Fetch-Site: cross-site is refused except for a top-level GET navigation (Sec-Fetch-Mode: navigate, Dest: document),
//     which the OIDC sign-in redirect needs and which cannot read the response (a web page you have open cannot make blind requests);
//   * only origin-form request lines (GET /path) are accepted: absolute-URI proxy requests, CONNECT and Upgrade are refused;
//   * only an allow-list of request headers is forwarded (never Cookie, Referer, Sec-Fetch-*, X-Forwarded-*, ...);
//     extend it with PROXY_EXTRA_HEADERS=name1,name2 if your client needs another one;
//   * it refuses to start when something already listens on the port (another process could otherwise sit in front of it);
//   * PROXY_REQUIRE_SECRET=header|path (opt-in) additionally requires a random per-run secret, printed once at startup:
//     header: `X-Proxy-Secret: <secret>`;   path: every request path starts with /<secret>/ (the prefix is stripped).
//   Tokens are never printed or logged.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const [target, portArg] = process.argv.slice(2);
if (!target || !portArg) { console.error('usage: node deploy/proxy.mjs <service-url> <local-port>'); process.exit(1); }
let url;
try { url = new URL(target); } catch { console.error('refusing: the service URL is not a URL'); process.exit(1); }
const port = Number(portArg);

// Test-only: forward to a plain-http loopback mock instead of Cloud Run. It needs BOTH the target https://proxy-test.invalid
// (a reserved name that never resolves, so normal use, which requires *.run.app, can never reach it) and the variable below,
// and the mock must be on 127.0.0.1. Your identity token is otherwise only ever sent to a Cloud Run service over https.
let testUpstream = null;
if (url.hostname === 'proxy-test.invalid') {
  let t;
  try { t = new URL(process.env.CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM || ''); } catch { t = null; }
  if (!t || t.protocol !== 'http:' || t.hostname !== '127.0.0.1' || !t.port) { console.error('refusing: the target must be an https://*.run.app Cloud Run URL'); process.exit(1); }
  testUpstream = { host: '127.0.0.1', port: Number(t.port) };
} else if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app')) {
  console.error('refusing: the target must be an https://*.run.app Cloud Run URL'); process.exit(1);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('refusing: local port must be 1024-65535'); process.exit(1); }

const secretMode = process.env.PROXY_REQUIRE_SECRET || '';
if (secretMode && secretMode !== 'header' && secretMode !== 'path') { console.error('refusing: PROXY_REQUIRE_SECRET must be "header" or "path"'); process.exit(1); }
const secret = secretMode ? crypto.randomBytes(24).toString('hex') : '';
const secretBuf = Buffer.from(secret);
const sameSecret = (v) => { const b = Buffer.from(String(v || '')); return b.length === secretBuf.length && crypto.timingSafeEqual(b, secretBuf); };

let tok = { v: '', exp: 0 };
function identityToken() {
  if (Date.now() < tok.exp) return Promise.resolve(tok.v);
  return new Promise((ok, no) => execFile('gcloud', ['auth', 'print-identity-token'], { timeout: 20000 }, (e, out) => {
    // The message is deliberately generic: it must never carry the token or gcloud's output.
    if (e || !String(out).trim()) return no(new Error('gcloud auth print-identity-token failed (are you logged in? try: gcloud auth login)'));
    tok = { v: String(out).trim(), exp: Date.now() + 45 * 60e3 };   // ID tokens last an hour
    ok(tok.v);
  }));
}

// Request headers that are forwarded to the service. Everything else is dropped.
const PASS = new Set(['authorization', 'content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding', 'accept-language',
  'user-agent', 'cache-control', 'pragma', 'if-none-match', 'if-modified-since', 'range', 'idempotency-key', 'last-event-id',
  'origin', 'x-app-token', 'x-request-id', 'x-api-key', 'x-app', 'x-session-id', 'x-client-request-id']);
const PASS_PREFIX = ['anthropic-', 'x-stainless-', 'x-claude-'];
for (const h of String(process.env.PROXY_EXTRA_HEADERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
  if (/^[a-z0-9-]+$/.test(h) && h !== 'cookie' && h !== 'x-serverless-authorization' && h !== 'host') PASS.add(h);
}
const forwardable = (k) => PASS.has(k) || PASS_PREFIX.some((p) => k.startsWith(p));

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

const okHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const okOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

function refuse(res, code, why) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
  res.end(why);
}

// The one cross-site request that must work: a top-level GET navigation. The OIDC redirect from accounts.google.com to
// <public_url>/oauth/callback IS cross-site (and so is every later hop of a redirect chain that started cross-site, which keeps
// Sec-Fetch-Site: cross-site, so this cannot be restricted by path). It is safe to forward because a cross-site navigation cannot
// read the response (the page that triggered it gets nothing back) and the gateway and budget app have no state-changing GET
// endpoints. Everything else cross-site stays refused: fetch/XHR/img/script (mode cors/no-cors), form POSTs and any non-GET,
// iframes and other embeds (dest is not "document"), and any request carrying a foreign Origin (checked before this).
function crossSiteNavigation(req) {
  const h = req.headers;
  return req.method === 'GET'
    && String(h['sec-fetch-mode'] || '').toLowerCase() === 'navigate'
    && String(h['sec-fetch-dest'] || '').toLowerCase() === 'document';
}

function check(req) {   // -> null when allowed, else [status, reason]
  if (req.method === 'CONNECT') return [405, 'CONNECT is not supported'];
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return [400, 'only origin-form request targets are accepted'];
  if (!okHosts.has(String(req.headers.host || '').toLowerCase())) return [400, 'bad host'];
  if (req.headers.origin !== undefined && !okOrigins.has(String(req.headers.origin).toLowerCase())) return [403, 'cross-origin request refused'];
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site' && !crossSiteNavigation(req)) return [403, 'cross-site request refused'];
  if (secretMode === 'header' && !sameSecret(req.headers['x-proxy-secret'])) return [403, 'missing or wrong X-Proxy-Secret'];
  return null;
}

const server = http.createServer(async (req, res) => {
  const bad = check(req);
  if (!bad && String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') console.error('allowed: cross-site top-level navigation (GET)');
  if (bad) { console.error(`refused: ${bad[1]} (${req.method})`); return refuse(res, bad[0], bad[1]); }   // never the path: it can carry an OAuth code
  let path = req.url;
  if (secretMode === 'path') {
    const prefix = `/${secret}/`;
    if (!path.startsWith(prefix)) return refuse(res, 403, 'missing or wrong path prefix');
    path = '/' + path.slice(prefix.length);
  }
  let id;
  try { id = await identityToken(); } catch (e) { return refuse(res, 502, e.message); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && forwardable(k)) headers[k] = v;
  headers.host = url.host;
  headers['x-serverless-authorization'] = 'Bearer ' + id;
  const opts = testUpstream
    ? { host: testUpstream.host, port: testUpstream.port, method: req.method, path, headers }
    : { host: url.hostname, port: 443, method: req.method, path, headers };
  const up = (testUpstream ? http : https).request(opts, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', (e) => refuse(res, 502, 'upstream error: ' + e.code));
  req.on('aborted', () => up.destroy());
  req.pipe(up);
});
// CONNECT and Upgrade (websocket) are never proxied.
server.on('connect', (req, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); });
server.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `refusing: port ${port} is already in use. Stop the other process or choose another port.` : `cannot listen on 127.0.0.1:${port}: ${e.code || e.message}`);
  process.exit(1);
});

// Refuse to start when anything already answers on the port (on 127.0.0.1 or ::1). A plain bind can succeed next to a
// wildcard listener on some systems, which would leave another process able to receive the requests meant for this one.
function listening(host) {
  return new Promise((done) => {
    const s = net.connect({ host, port });
    const fin = (v) => { s.destroy(); done(v); };
    s.setTimeout(700, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}
if ((await listening('127.0.0.1')) || (await listening('::1'))) {
  console.error(`refusing: port ${port} is already in use. Stop the other process or choose another port.`);
  process.exit(1);
}
server.listen(port, '127.0.0.1', () => {
  const lines = [`proxy http://localhost:${port} -> ${url.origin}`];
  if (secretMode === 'header') lines.push(`per-run secret required: send the header  X-Proxy-Secret: ${secret}`);
  if (secretMode === 'path') lines.push(`per-run secret required: use http://localhost:${port}/${secret}/ as the base URL`);
  console.log(lines.join('\n'));   // one write: the secret line is never separated from the ready line
});
