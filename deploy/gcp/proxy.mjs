// Local authenticating proxy for a private Cloud Run service: localhost:<port> -> https://<service>.run.app
//
//   node proxy.mjs <service-url> <local-port>
//
// Adds your Google identity token (from `gcloud auth print-identity-token`) in X-Serverless-Authorization,
// which Cloud Run checks and strips before the request reaches the container. The client's own Authorization
// header (the gateway session token Claude Code sends) is passed through untouched, which is why this is used
// instead of `gcloud run services proxy`. Binds to loopback only. Responses stream (SSE works). No dependencies.
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';

const [target, portArg] = process.argv.slice(2);
if (!target || !portArg) { console.error('usage: node proxy.mjs <service-url> <local-port>'); process.exit(1); }
const url = new URL(target);
const port = Number(portArg);

let tok = { v: '', exp: 0 };
function identityToken() {
  if (Date.now() < tok.exp) return Promise.resolve(tok.v);
  return new Promise((ok, no) => execFile('gcloud', ['auth', 'print-identity-token'], { timeout: 20000 }, (e, out) => {
    if (e) return no(new Error('gcloud auth print-identity-token failed: ' + e.message));
    tok = { v: out.trim(), exp: Date.now() + 45 * 60e3 };   // ID tokens last an hour
    ok(tok.v);
  }));
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

http.createServer(async (req, res) => {
  // DNS-rebinding guard: only requests addressed to this machine's loopback name are forwarded with your identity.
  if (!['localhost', '127.0.0.1'].includes(String(req.headers.host || '').split(':')[0])) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad host'); }
  let id;
  try { id = await identityToken(); } catch (e) { res.writeHead(502, { 'content-type': 'text/plain' }); return res.end(e.message); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'x-serverless-authorization') headers[k] = v;
  headers.host = url.host;
  headers['x-serverless-authorization'] = 'Bearer ' + id;
  const up = https.request({ host: url.hostname, port: 443, method: req.method, path: req.url, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream error: ' + e.message); });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}).listen(port, '127.0.0.1', () => console.log(`proxy http://localhost:${port} -> ${url.origin}`));
