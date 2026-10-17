// Google Identity-Aware Proxy (IAP): verifies the signed JWT IAP puts in `x-goog-iap-jwt-assertion`.
//
// In APP_AUTH_MODE=iap this JWT is the only way in. It is checked fully here: ES256 signature against Google's published keys, `iss`, `aud`
// (exact match), `exp`/`iat` with a small skew and a maximum lifetime, a plausible `email` and a `sub`. The plain `x-goog-authenticated-user-*`
// headers are NOT signed: they are never read for identity (their appearance without a valid JWT is logged once as a misconfiguration signal).
// Nothing in here ever logs a token.
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';

export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
const IAP_ISS = 'https://cloud.google.com/iap';
const SKEW_S = 30, MAX_LIFE_S = 600 + 2 * SKEW_S;               // IAP tokens live 10 minutes
const MAX_TOKEN = 4096, MAX_KEYS_BODY = 64 * 1024, MAX_KEYS = 20;
const KEYS_TTL_MS = 3600e3, KEYS_STALE_MS = 6 * 3600e3, KEYS_REFETCH_MS = 60e3, KEYS_RETRY_MS = 5e3, FETCH_TIMEOUT_MS = 4000, LOG_EVERY_MS = 60e3;
const B64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@:<>"',;\\]{1,64}@[^\s@:<>"',;\\]{1,255}$/;
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

export function createIapVerifier(cfg, { now = () => Date.now(), log = (o) => console.log(JSON.stringify(o)), fetch: fetchImpl = (...a) => fetch(...a) } = {}) {
  const iap = cfg.iap;
  if (!iap?.audience) throw new Error('createIapVerifier needs cfg.iap.audience');
  const domains = new Set(iap.allowedDomains || []);
  let keys = { at: 0, byKid: new Map() }, loading = null, lastTry = -Infinity, lastFailed = false;
  let warnedHeaders = false;
  const lastLog = new Map();
  // One log line per reason per minute: a flood of bad tokens can neither fill the logs nor leak anything beyond the reason.
  const deny = (reason) => {
    const t = now();
    if (t - (lastLog.get(reason) ?? -Infinity) >= LOG_EVERY_MS) { lastLog.set(reason, t); log({ evt: 'iap.denied', reason }); }
    return null;
  };

  // ---------- keys: Google's JWK set, cached, rotated, refetched (rate limited) when a token names an unknown kid ----------
  async function readCapped(r) {
    const len = Number(r.headers?.get?.('content-length'));
    if (Number.isFinite(len) && len > MAX_KEYS_BODY) throw new Error('iap keys too large');
    let text = '';
    if (r.body?.getReader) {
      const rd = r.body.getReader(); const chunks = []; let n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        n += value.length;
        if (n > MAX_KEYS_BODY) { try { await rd.cancel(); } catch { /* ignore */ } throw new Error('iap keys too large'); }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await r.text();
    if (text.length > MAX_KEYS_BODY) throw new Error('iap keys too large');
    return text;
  }
  async function loadKeys() {
    const r = await fetchImpl(iap.keysUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('iap keys ' + r.status);
    const list = JSON.parse(await readCapped(r))?.keys;
    if (!Array.isArray(list) || list.length > MAX_KEYS) throw new Error('iap keys shape');
    const byKid = new Map();
    for (const jwk of list) {
      // Only P-256 signing keys usable for ES256. Anything else in the set is ignored, never "best effort" accepted.
      if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || (jwk.alg && jwk.alg !== 'ES256') || (jwk.use && jwk.use !== 'sig')) continue;
      try { byKid.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' })); } catch { /* malformed key: skip */ }
    }
    if (!byKid.size) throw new Error('iap keys: none usable');
    keys = { at: now(), byKid };
  }
  // A fresh set is used as is. A stale one is refreshed; if that fails the stale copy serves for a while, then we fail closed (503).
  // An unknown kid triggers at most one refetch a minute after a SUCCESSFUL fetch (Google rotates keys, and the fetch that just worked has
  // the new key if it exists), but after a FAILED fetch the retry floor is only 5 s and a kid we cannot find is answered 503 ("keys
  // unavailable"), never 401: a failed fetch at the moment of a rotation must not lock the new key out or tell people they are not allowed.
  const attempt = () => {
    lastTry = now();
    loading ||= loadKeys().then(() => { lastFailed = false; }, (e) => { lastFailed = true; log({ evt: 'iap.keys.error', error: String(e?.message || e).slice(0, 120) }); }).finally(() => { loading = null; });
    return loading;
  };
  async function keyFor(kid) {
    const t = now();
    const have = keys.byKid.size > 0;
    const stale = !have || t - keys.at >= KEYS_TTL_MS;
    const unknown = have && !keys.byKid.has(kid);
    if ((stale && t - lastTry > KEYS_RETRY_MS) || (unknown && t - lastTry > (lastFailed ? KEYS_RETRY_MS : KEYS_REFETCH_MS))) await attempt();
    else if (loading) await loading;                       // someone else's fetch is in flight: use its result
    const unavailable = () => new HttpError(503, 'sign-in verification is unavailable, try again shortly', { headers: { 'retry-after': '5' } });
    if (!keys.byKid.size || now() - keys.at > KEYS_STALE_MS) throw unavailable();
    const key = keys.byKid.get(kid) || null;
    if (!key && lastFailed) throw unavailable();
    return key;
  }

  // ---------- the JWT ----------
  const jsonPart = (s) => { try { return plain(JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))); } catch { return null; } };
  // Returns { email, sub, hd } for a valid token, null for anything else (the reason is logged, rate limited, without the token).
  // Throws HttpError(503) only when the keys cannot be had at all.
  async function verifyToken(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return deny(token === undefined || token === '' ? 'missing' : typeof token !== 'string' ? 'malformed' : 'too_large');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return deny('malformed');
    const head = jsonPart(parts[0]), c = jsonPart(parts[1]);
    if (!head || !c) return deny('malformed');
    // Only ES256, strictly: never `none`, HS* (a public key must not become an HMAC secret) or RS*. No `crit` extensions are understood.
    if (head.alg !== 'ES256') return deny('alg');
    if (head.crit !== undefined) return deny('crit');
    if (typeof head.kid !== 'string' || !head.kid || head.kid.length > 128) return deny('kid');
    const sig = Buffer.from(parts[2], 'base64url');
    if (sig.length !== 64) return deny('signature_format');           // ES256 JWS signatures are exactly r||s, 32 bytes each

    // Cheap claim checks first, so junk costs no network call. They are trusted only once the signature below verifies.
    if (c.iss !== IAP_ISS) return deny('iss');
    if (typeof c.aud !== 'string' || c.aud !== iap.audience) return deny('aud');
    const t = Math.floor(now() / 1000);
    if (!Number.isFinite(c.exp) || !Number.isFinite(c.iat)) return deny('time_claims');
    if (c.exp + SKEW_S <= t) return deny('expired');
    if (c.iat - SKEW_S > t) return deny('iat_future');
    if (c.exp <= c.iat || c.exp - c.iat > MAX_LIFE_S) return deny('lifetime');
    if (c.nbf !== undefined && (!Number.isFinite(c.nbf) || c.nbf - SKEW_S > t)) return deny('nbf');
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) return deny('sub');
    if (typeof c.email !== 'string' || !EMAIL_RE.test(c.email)) return deny('email');
    if (c.email_verified !== undefined && c.email_verified !== true) return deny('email_verified');
    const email = c.email.toLowerCase();
    if (domains.size) {
      // With a domain list, BOTH the email's domain and the Workspace domain (`hd`) must be on it: a consumer account that merely
      // carries a corporate-looking address has no `hd`.
      const hd = typeof c.hd === 'string' ? c.hd.toLowerCase() : '';
      if (!domains.has(email.slice(email.lastIndexOf('@') + 1)) || !domains.has(hd)) return deny('domain');
    }

    const key = await keyFor(head.kid);
    if (!key) return deny('unknown_kid');
    let ok = false;
    try { ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key, dsaEncoding: 'ieee-p1363' }, sig); } catch { ok = false; }
    if (!ok) return deny('signature');
    return { email, sub: c.sub, hd: typeof c.hd === 'string' ? c.hd.toLowerCase() : null, exp: c.exp };
  }

  // The identity of a request, or null. Also notes (once per process) the unsigned headers that must never be trusted.
  async function identify(req) {
    const raw = req.headers[IAP_HEADER];
    const id = Array.isArray(raw) ? deny('malformed') : await verifyToken(raw);
    if (!id && !warnedHeaders && (req.headers['x-goog-authenticated-user-email'] || req.headers['x-goog-authenticated-user-id'])) {
      warnedHeaders = true;
      log({ evt: 'iap.misconfigured', note: 'x-goog-authenticated-user-* headers arrived without a valid signed IAP JWT: they are ignored. Is the service reachable without going through IAP?' });
    }
    return id;
  }
  return { identify, verifyToken, keysLoaded: () => keys.byKid.size };
}
