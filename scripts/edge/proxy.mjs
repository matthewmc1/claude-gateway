// Shared by the IAP and ILB emulators: a small streaming reverse proxy on node:http (no dependencies).
// The request goes to the upstream with the ORIGINAL Host header (like Google's proxies), so the upstream sees the public name.
import http from 'node:http';

// Hop-by-hop headers (RFC 9110 7.6.1) are never forwarded.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

export function forward(req, res, { upstream, headers, path = req.url, timeoutMs = 60000, onResponse }) {
  const u = new URL(upstream);
  const out = {};
  for (const [k, v] of Object.entries(headers || req.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
  const up = http.request({ host: u.hostname, port: u.port, method: req.method, path, headers: out, timeout: timeoutMs }, (r) => {
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
    if (onResponse) onResponse(r, h);
    res.writeHead(r.statusCode, r.statusMessage, h);
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad gateway', detail: e.code || e.message }));
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

export const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
export const log = (name, o) => console.log(JSON.stringify({ ts: new Date().toISOString(), proxy: name, ...o }));
