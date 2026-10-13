// Admin authentication: signed session tokens, login throttling, session revocation, and the Cloud Scheduler check.
//
// Modes (first match wins):
//   accounts  APP_ADMINS (or the demo admin when APP_DEMO=1): email + password, each admin has their own gateway write key.
//   local     APP_ADMIN_PASSWORD + GATEWAY_ADMIN_WRITE_KEY: one shared password, the actor shows as `local-admin`.
// Nothing here ever returns or logs a password, key or the session secret.
//
// Sessions are stateless HMAC tokens carrying `iat`, `exp` and a per-account version. `revoke(email)` bumps that version, which
// invalidates every session of that account. Versions live in memory under a random per-process epoch, so a restart (or rotating
// APP_SESSION_SECRET) invalidates every session too. With more than one instance, a logout only reaches the instance that served it.
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';
import { DEMO_ADMIN } from './demo-users.mjs';

const SESSION_MS = 12 * 3600e3;
// Login throttling. After `free` failures a key is locked for BASE_MS, doubling with each further failure up to MAX_MS.
//   per (account, client IP)  5 free failures: hard lock for that address only, so an attacker cannot lock the real admin out.
//   per client IP             10 free failures across all accounts: hard lock for that address.
//   per account, all IPs      SUSPICIOUS_AT failures in an hour: log `admin.login.suspicious` and slow every attempt on that account
//                             by SLOW_MS. It never blocks: a correct password from an address with no failures still gets in.
const ACCOUNT_FREE = 5, IP_FREE = 10, SUSPICIOUS_AT = 50, SUSPICIOUS_WINDOW_MS = 3600e3, SLOW_MS = 1500, BASE_MS = 30e3, MAX_MS = 15 * 60e3, IDLE_MS = 30 * 60e3, MAX_KEYS = 5000;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));   // hashing first makes both sides 32 bytes, so lengths don't leak
const GOOGLE_ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 3600e3, JWKS_STALE_MS = 6 * 3600e3, JWKS_REFETCH_MS = 60e3, SKEW_MS = 60e3, MAX_TOKEN_LIFE_S = 24 * 3600, MAX_BEARER = 8192;

// A bounded table of failure counters with exponential lockout. Entries expire when idle; the oldest go first when full.
function createThrottle(free, now) {
  const m = new Map();
  const live = (e, t) => e.until > t || t - e.last < IDLE_MS;
  return {
    wait(key) { const e = m.get(key), t = now(); return e && e.until > t ? e.until - t : 0; },
    fail(key) {
      const t = now(); let e = m.get(key);
      if (!e || !live(e, t)) e = { n: 0, until: 0, last: t };
      e.n++; e.last = t;
      if (e.n >= free) e.until = t + Math.min(MAX_MS, BASE_MS * 2 ** Math.min(30, e.n - free));
      m.delete(key); m.set(key, e);
      if (m.size > MAX_KEYS) {
        for (const [k, v] of m) if (!live(v, t)) m.delete(k);
        for (const k of m.keys()) { if (m.size <= MAX_KEYS) break; m.delete(k); }
      }
    },
    clear(key) { m.delete(key); },
    get size() { return m.size; },
  };
}

export function createAuth(cfg, { now = () => Date.now(), log = (o) => console.log(JSON.stringify(o)), fetch: fetchImpl = (...a) => fetch(...a) } = {}) {
  const secret = sha('budget-app:' + cfg.sessionSecret);
  const accounts = cfg.admins?.length
    ? cfg.admins
    : cfg.demo ? [{ email: DEMO_ADMIN.email, name: DEMO_ADMIN.name, password: DEMO_ADMIN.password, writeKey: cfg.writeKey || 'demo-key' }] : [];
  const accountsMode = accounts.length > 0;
  const localMode = !accountsMode && !!cfg.localPassword;
  const dummy = crypto.randomBytes(16).toString('hex');   // compared against when the email is unknown, so timing is the same
  const byIp = createThrottle(IP_FREE, now), byAccount = createThrottle(ACCOUNT_FREE, now), byGhost = createThrottle(ACCOUNT_FREE, now);
  const hourly = new Map();                       // real account -> { n, since }: failures from any address in the current hour

  // Per-account session version: a random per-process epoch plus a counter, so a restart never revives a revoked token.
  const epoch = crypto.randomBytes(8).toString('hex'); const versions = new Map();
  const versionOf = (email) => epoch + ':' + (versions.get(email) || 0);
  function revoke(email) { versions.set(email, (versions.get(email) || 0) + 1); }

  const sign = (p) => crypto.createHmac('sha256', secret).update(p).digest('base64url');
  function mint(email, name) {
    const t = now();
    const p = Buffer.from(JSON.stringify({ iat: t, exp: t + SESSION_MS, tv: versionOf(email), email, name })).toString('base64url');
    return p + '.' + sign(p);
  }
  function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const good = Buffer.from(sign(parts[0])), got = Buffer.from(parts[1]);
    if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
    try {
      const d = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (!d || typeof d.exp !== 'number' || d.exp <= now() || typeof d.iat !== 'number' || d.iat > now() + SKEW_MS) return null;
      if (typeof d.email !== 'string' || d.tv !== versionOf(d.email)) return null;       // revoked (logout) or issued before this process started
      return d;
    } catch { return null; }
  }
  // The signed-in admin: their own gateway key in accounts mode, the shared local key otherwise. A removed account's sessions stop working.
  function adminFor(sess) {
    if (!sess) return null;
    if (accountsMode) {
      const a = accounts.find((x) => x.email === sess.email);
      return a ? { email: a.email, name: a.name, writeKey: a.writeKey } : null;
    }
    if (localMode && sess.email === 'local-admin') return { email: 'local-admin', name: 'Admin', writeKey: cfg.writeKey };
    return null;
  }
  // x-app-token first: behind Cloud Run IAM or `gcloud run services proxy`, Authorization carries Google's identity token.
  const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer /i, '');
  const sessionToken = (req) => {
    const t = req.headers['x-app-token'];
    if (t) return String(t);
    const b = bearer(req);
    return b.split('.').length === 2 ? b : '';       // a Google ID token has three parts: never a session
  };

  function login(body, { ip = 'unknown' } = {}) {
    const password = typeof body?.password === 'string' ? body.password : '';
    const email = accountsMode ? (typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : '') : 'local-admin';
    const acct = accountsMode ? accounts.find((x) => x.email === email) : null;
    // The password is always checked first, in constant time, so neither timing nor the order of checks tells an attacker anything.
    let who = null;
    if (accountsMode) {
      const good = safeEq(password, acct ? acct.password : dummy);
      if (acct && good) who = { email: acct.email, name: acct.name };
    } else if (localMode) {
      if (safeEq(password, cfg.localPassword)) who = { email: 'local-admin', name: 'Admin' };
    }
    // Real accounts and made-up emails use separate tables with the same rules, so a 429 never reveals which emails exist.
    const table = accountsMode && !acct ? byGhost : byAccount;
    const pair = (accountsMode ? email : 'local-admin') + '|' + ip;
    const t = now();
    let h = hourly.get(email);
    if (h && t - h.since > SUSPICIOUS_WINDOW_MS) { hourly.delete(email); h = null; }
    const slow = h && h.n >= SUSPICIOUS_AT ? SLOW_MS : 0;
    const wait = Math.max(byIp.wait(ip), table.wait(pair));
    if (wait > 0) {                                     // this address is locked: even the right password is refused
      log({ evt: 'admin.login.failed', reason: 'throttled' });
      throw Object.assign(new HttpError(429, 'too many attempts, try again later', { headers: { 'retry-after': String(Math.ceil(wait / 1000)) } }), { delayMs: slow });
    }
    if (!who) {
      byIp.fail(ip); table.fail(pair);
      if (acct || localMode) {
        if (!h) { h = { n: 0, since: t }; hourly.set(email, h); if (hourly.size > MAX_KEYS) hourly.delete(hourly.keys().next().value); }
        h.n++;
        if (h.n === SUSPICIOUS_AT) log({ evt: 'admin.login.suspicious', failures: h.n, windowMinutes: 60 });   // no email, no password
      }
      log({ evt: 'admin.login.failed', reason: 'bad_credentials' });
      throw Object.assign(new HttpError(401, accountsMode ? 'wrong email or password' : 'wrong password'), { delayMs: slow });
    }
    table.clear(pair);
    log({ evt: 'admin.login', email: who.email });
    return { token: mint(who.email, who.name), email: who.email, name: who.name, delayMs: slow };
  }

  const optionalAdmin = (req) => adminFor(verify(sessionToken(req)));
  function requireAdmin(req) {
    const a = optionalAdmin(req);
    if (!a) throw new HttpError(401, 'sign in required');
    return a;
  }
  // Ends the caller's session and every other session of the same account.
  function logout(req) {
    const a = requireAdmin(req);
    revoke(a.email);
    log({ evt: 'admin.logout', email: a.email });
    return { ok: true };
  }

  // ---------- Cloud Scheduler: a Google-signed ID token, verified here against Google's published keys ----------
  let jwks = { at: 0, keys: [] }, jwksLoading = null, lastRefetch = -Infinity;
  async function loadJwks() {
    const r = await fetchImpl(GOOGLE_CERTS, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('jwks ' + r.status);
    const keys = (await r.json())?.keys;
    if (!Array.isArray(keys)) throw new Error('jwks shape');
    jwks = { at: now(), keys };
  }
  // `force` allows one refetch a minute when a token names a key we do not have (Google rotates keys). Failures use a stale copy for a while, then fail closed.
  async function getKey(kid, force) {
    const t = now();
    const fresh = jwks.keys.length && t - jwks.at < JWKS_TTL_MS;
    const missing = jwks.keys.length && !jwks.keys.some((k) => k.kid === kid);
    if (!fresh || (force && missing && t - lastRefetch > JWKS_REFETCH_MS)) {
      lastRefetch = t;
      jwksLoading ||= loadJwks().finally(() => { jwksLoading = null; });
      try { await jwksLoading; } catch (e) { if (!jwks.keys.length || t - jwks.at > JWKS_STALE_MS) throw e; }
    }
    return jwks.keys.find((k) => k.kid === kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig')) || null;
  }
  async function schedulerClaims(req) {
    if (!cfg.inCloud || !cfg.schedulerSa || !cfg.schedulerAudience) return null;     // fail closed: nothing configured, nothing accepted
    const token = bearer(req);
    if (!token || token.length > MAX_BEARER) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[2]) return null;
    let head, c;
    try {
      head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch { return null; }
    if (!head || !c || typeof c !== 'object' || head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
    // Cheap claim checks first, so junk never costs a network call. They are only trusted once the signature below verifies.
    const t = now();
    if (typeof c.email !== 'string' || c.email.toLowerCase() !== cfg.schedulerSa.toLowerCase() || c.email_verified !== true) return null;
    if (!GOOGLE_ISS.has(c.iss) || c.aud !== cfg.schedulerAudience) return null;
    if (typeof c.exp !== 'number' || typeof c.iat !== 'number' || c.exp * 1000 <= t || c.iat * 1000 > t + SKEW_MS || c.exp - c.iat > MAX_TOKEN_LIFE_S) return null;
    try {
      const jwk = await getKey(head.kid, true);
      if (!jwk) return null;
      const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
      return ok ? c : null;
    } catch (e) { log({ evt: 'scheduler.verify.error', error: String(e?.message || e).slice(0, 120) }); return null; }
  }
  // POST /api/internal/tick: an admin session or the scheduler. Returns who was accepted, or throws 401.
  async function requireScheduler(req) {
    const a = optionalAdmin(req);
    if (a) return { via: 'admin', email: a.email };
    const c = await schedulerClaims(req);
    if (c) return { via: 'scheduler', email: c.email };
    throw new HttpError(401, 'sign in required');
  }

  return { login, logout, revoke, requireAdmin, optionalAdmin, requireScheduler, accounts: accountsMode, mint, verify, throttleSizes: () => ({ ip: byIp.size, account: byAccount.size, ghost: byGhost.size }) };
}
