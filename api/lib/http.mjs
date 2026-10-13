import fs from 'node:fs';
import path from 'node:path';

// `headers` are extra response headers (e.g. Retry-After); `upstream` marks an error that came from the gateway (its text is filtered before it reaches a client).
export class HttpError extends Error { constructor(status, message, { headers = null, upstream = false } = {}) { super(message); this.status = status; this.headers = headers; this.upstream = upstream; } }

export const send = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

export const readBody = (req, limit = 20000) => new Promise((ok, no) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > limit) { no(new HttpError(413, 'too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new HttpError(400, 'bad json')); } });
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };
// The app is plain static files plus same-origin API calls, so the policy can be strict.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function serveStatic(dist, res, pathname) {
  let file = path.normalize(path.join(dist, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(dist)) return send(res, 400, { error: 'bad path' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('App not built yet. Run: cd app && npx expo export -p web'); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  });
  fs.createReadStream(file).pipe(res);
}
