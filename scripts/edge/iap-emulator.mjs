// A stand-in for Google Identity-Aware Proxy in front of the budget app. NOT Google: it exists so the exact topology of the
// deployed app (browser -> IAP -> app, one origin, signed JWT in x-goog-iap-jwt-assertion) runs on a laptop with no cloud access.
//
//   node scripts/edge/iap-emulator.mjs --port 19330 --upstream http://127.0.0.1:19334 --audience /projects/1/locations/r/services/s \
//        --users ada@example.com,bob@example.com
//
// Behaviour (what is imitated, and where it is simplified):
//  * No session cookie: GET navigations get a 302 to /_iap/signin (real IAP: accounts.google.com); requests that ask for JSON
//    (accept: application/json) get a 401 instead of a redirect.
//  * Sign-in picks an email from --users (a person not on the list gets IAP's 403 "no access"; --allow-any admits anyone).
//  * Signed in: strips every client-supplied x-goog-* header (and x-forwarded-*), then forwards with the Host header preserved
//    plus x-goog-iap-jwt-assertion (ES256, iss https://cloud.google.com/iap, aud --audience, ~10 min life, kid) and the unsigned
//    x-goog-authenticated-user-email / -id headers real IAP also adds. The app must trust ONLY the JWT.
//  * The per-run public key set is served at /.well-known/iap-keys.json (real IAP: https://www.gstatic.com/iap/verify/public_key-jwk).
//  * ?secure_token_test=<kind> sends a deliberately broken JWT so you can prove the app rejects it (see BAD_KINDS).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { forward, clientIp, log } from './proxy.mjs';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export const COOKIE = 'iap_emulator';
export const BAD_KINDS = ['bad-signature', 'expired', 'wrong-aud', 'wrong-iss', 'wrong-alg', 'unknown-kid', 'too-long', 'no-email', 'garbage', 'none'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// IAP's subject is a stable numeric Google account id; derive a deterministic fake one from the email.
const numericId = (email) => `1${BigInt('0x' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 14)).toString().padStart(20, '0')}`.slice(0, 21);
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])[^\r\n]*$/.test(n) ? n : '/');

export function startIapEmulator({ port, host = '127.0.0.1', upstream, audience, users = [], allowAny = false, scheme = 'http', quiet = false, lifetimeSec = 600 }) {
  if (!upstream || !audience) throw new Error('iap emulator needs upstream and audience');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;   // signs the "bad-signature" token
  const kid = crypto.randomBytes(8).toString('hex');
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid }] };
  const secret = crypto.randomBytes(32);
  const allowed = users.map((u) => u.trim().toLowerCase()).filter(Boolean);
  const emu = { audience, kid, jwks, users: allowed, port: null, server: null };

  const sign = (data, key) => crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const claimsFor = (email, now = Math.floor(Date.now() / 1000)) => {
    const domain = email.split('@')[1] || '';
    return {
      iss: 'https://cloud.google.com/iap', aud: audience, sub: `accounts.google.com:${numericId(email)}`,
      email, iat: now, exp: now + lifetimeSec, ...(domain && !/^(gmail|googlemail)\.com$/.test(domain) ? { hd: domain } : {}), google: { access_levels: [] },
    };
  };
  // A JWT as IAP would send it, or one broken in the way `kind` says.
  function makeJwt(email, kind = null) {
    const now = Math.floor(Date.now() / 1000);
    let header = { alg: 'ES256', typ: 'JWT', kid }, claims = claimsFor(email, now), key = privateKey;
    if (kind === 'garbage') return 'not.a.jwt!';
    if (kind === 'bad-signature') key = other;
    if (kind === 'expired') claims = { ...claims, iat: now - 1200, exp: now - 600 };
    if (kind === 'too-long') claims = { ...claims, exp: now + 3600 };
    if (kind === 'wrong-aud') claims = { ...claims, aud: '/projects/1/global/backendServices/evil' };
    if (kind === 'wrong-iss') claims = { ...claims, iss: 'https://accounts.example.invalid' };
    if (kind === 'no-email') { const { email: _e, ...rest } = claims; claims = rest; }
    if (kind === 'unknown-kid') header = { ...header, kid: 'not-a-published-key' };
    if (kind === 'wrong-alg') {   // HS256 keyed with the public key: the classic algorithm-confusion token
      const h = b64({ alg: 'HS256', typ: 'JWT', kid }), p = b64(claims);
      return `${h}.${p}.${crypto.createHmac('sha256', JSON.stringify(jwks.keys[0])).update(`${h}.${p}`).digest('base64url')}`;
    }
    const h = b64(header), p = b64(claims);
    return `${h}.${p}.${sign(`${h}.${p}`, key)}`;
  }
  emu.makeJwt = makeJwt;

  const mac = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  const sessionCookie = (email) => { const v = b64(email); return `${v}.${mac(v)}`; };
  const emailFromCookie = (req) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    if (!m) return null;
    const [v, sig] = m[1].split('.');
    if (!v || !sig) return null;
    // Compare BYTES (a non-ASCII cookie has equal string length but another byte length, and timingSafeEqual throws on unequal lengths).
    const got = Buffer.from(sig), want = Buffer.from(mac(v));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try { return Buffer.from(v, 'base64url').toString('utf8'); } catch { return null; }
  };
  const setCookie = (email) => `${COOKIE}=${email ? sessionCookie(email) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${email ? 28800 : 0}${scheme === 'https' ? '; Secure' : ''}`;

  const page = (res, status, title, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...extra });
    res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#1d1d1f}button{font:inherit;padding:.5rem .8rem;margin:.2rem 0;width:100%;text-align:left;cursor:pointer}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}.n{color:#a33;font-size:13px}</style>${body}`);
  };
  const signinPage = (res, next, error = '') => page(res, error ? 403 : 200, 'Sign in (IAP emulator)', `<h1>Sign in</h1>
<p class=n>Local IAP emulator. This is not Google: it only imitates the sign-in step so the app sees the same headers it will in production.</p>${error ? `<p class=n>${esc(error)}</p>` : ''}
<form method=post action="/_iap/signin"><input type=hidden name=next value="${esc(next)}">
${allowed.map((e) => `<button name=email value="${esc(e)}">${esc(e)}</button>`).join('')}
${allowAny || !allowed.length ? '' : '<p>Or type an address (only listed people get access, like IAP\'s IAM check):</p>'}
<input name=custom type=email placeholder="someone@example.com" autocomplete=off><button type=submit>Sign in with typed address</button></form>`);

  const readForm = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 8192) req.destroy(); }); req.on('end', () => ok(new URLSearchParams(d))); });
  const note = (o) => { if (!quiet) log('iap', o); };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const hostHeader = req.headers.host || '';
    if (url.pathname === '/.well-known/iap-keys.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(jwks)); }
    if (url.pathname === '/_iap/signin' && req.method === 'GET') return signinPage(res, safeNext(url.searchParams.get('next')));
    if (url.pathname === '/_iap/signin' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `${scheme}://${hostHeader}`) return page(res, 403, 'Refused', '<p>cross-origin sign-in refused</p>');
      const f = await readForm(req), next = safeNext(f.get('next'));
      const email = String(f.get('email') || f.get('custom') || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return signinPage(res, next, 'Enter an email address.');
      if (!allowAny && !allowed.includes(email)) { note({ evt: 'iap.denied', email }); return signinPage(res, next, `You don't have access: ${email} is not on this emulator's user list.`); }
      note({ evt: 'iap.signin', email });
      res.writeHead(302, { location: next, 'set-cookie': setCookie(email), 'cache-control': 'no-store' }); return res.end();
    }
    if (url.pathname === '/_iap/signout') { res.writeHead(302, { location: '/_iap/signin', 'set-cookie': setCookie(null) }); return res.end(); }

    const email = emailFromCookie(req);
    if (!email) {
      const wantsJson = /application\/json/.test(req.headers.accept || '') && !/text\/html/.test(req.headers.accept || '');
      note({ evt: 'iap.unauthenticated', method: req.method, path: url.pathname, json: wantsJson });
      if (wantsJson || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: 'sign-in required', signIn: '/_iap/signin' })); }
      res.writeHead(302, { location: '/_iap/signin?next=' + encodeURIComponent(req.url), 'cache-control': 'no-store' }); return res.end();
    }

    // Signed in. A test query parameter swaps in a broken token and is not forwarded to the app.
    const kind = url.searchParams.has('secure_token_test') ? (url.searchParams.get('secure_token_test') || 'bad-signature') : null;
    if (kind !== null) url.searchParams.delete('secure_token_test');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith('x-goog-') && !k.startsWith('x-forwarded-') && k !== 'forwarded' && k !== 'x-real-ip') headers[k] = v;
    if (headers.cookie) { headers.cookie = headers.cookie.split(/;\s*/).filter((c) => !c.startsWith(COOKIE + '=')).join('; '); if (!headers.cookie) delete headers.cookie; }
    headers['x-forwarded-for'] = clientIp(req); headers['x-forwarded-proto'] = scheme;
    if (kind !== 'none') {
      headers['x-goog-iap-jwt-assertion'] = makeJwt(email, kind);
      headers['x-goog-authenticated-user-email'] = `accounts.google.com:${email}`;
      headers['x-goog-authenticated-user-id'] = `accounts.google.com:${numericId(email)}`;
    }
    note({ evt: 'iap.forward', email, method: req.method, path: url.pathname, ...(kind !== null ? { secure_token_test: kind } : {}) });
    forward(req, res, { upstream, headers, path: url.pathname + (url.search || '') });
  };
  // Whatever goes wrong in a handler is one 500 for that request, never an unhandled rejection that kills the emulator.
  emu.server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      note({ evt: 'iap.error', error: String(e?.message || e).slice(0, 120) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'emulator error' }));
    });
  });

  return new Promise((ok, no) => {
    emu.server.once('error', no);
    emu.server.listen(port, host, () => {
      emu.port = emu.server.address().port;
      emu.close = () => new Promise((r) => { emu.server.close(r); emu.server.closeAllConnections?.(); });
      ok(emu);
    });
  });
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  const { values: v } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, upstream: { type: 'string' }, audience: { type: 'string' }, users: { type: 'string' }, scheme: { type: 'string' }, 'allow-any': { type: 'boolean' } } });
  const emu = await startIapEmulator({ port: Number(v.port || process.env.EDGE_IAP_PORT), host: v.host, upstream: v.upstream || process.env.EDGE_IAP_UPSTREAM, audience: v.audience || process.env.EDGE_IAP_AUDIENCE, users: (v.users || process.env.EDGE_USERS || '').split(','), allowAny: v['allow-any'], scheme: v.scheme || 'http' });
  console.log(JSON.stringify({ evt: 'listening', proxy: 'iap', port: emu.port, upstream: v.upstream || process.env.EDGE_IAP_UPSTREAM, audience: emu.audience, kid: emu.kid }));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => emu.close().then(() => process.exit(0)));
}
