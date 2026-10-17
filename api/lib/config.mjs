// All configuration comes from the environment, validated once at start-up. Pure function of `env`, so tests can pass their own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const BUILTIN_CATALOG = {
  default: 'sonnet-4-6',
  models: [
    { alias: 'sonnet', id: 'claude-sonnet-5-5', family: 'sonnet', pin: false, label: 'Sonnet 5.5', tier: 'previous', description: 'The newer Sonnet generation, available by name.', enabled: true },
    { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'upgrade', description: 'Hardest problems. Costs more.', enabled: true },
    { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'fast', description: 'Fast and cheap for simple tasks.', enabled: true },
    { alias: 'sonnet-4-6', id: 'claude-sonnet-4-6', family: 'sonnet', pin: true, label: 'Sonnet 4.6', tier: 'default', description: 'Everyday coding. The baseline.', enabled: true },
    { alias: 'opus-4-6', id: 'claude-opus-4-6', family: 'opus', label: 'Opus 4.6', tier: 'previous', description: 'The previous Opus generation.', enabled: true },
  ],
};

// The three aliases Claude Code understands. An entry belongs to a family (explicit `family`, else its alias when that is one of these)
// and PINS it (sets ANTHROPIC_DEFAULT_<FAMILY>_MODEL for everyone) when `pin` is true, or by default when alias == family.
export const MODEL_FAMILIES = ['sonnet', 'opus', 'haiku'];
export const familyOf = (m) => (m.family !== undefined ? m.family : MODEL_FAMILIES.includes(String(m.alias).toLowerCase()) ? String(m.alias).toLowerCase() : null);

// Same rules as the installer and Terraform (all three refuse the same catalogs): unique aliases (case-insensitive) and ids, a valid family,
// a pinned entry has a family and is enabled, at most one pinned entry per family, and `default` names an enabled entry (alias or id).
export function normalizeCatalog(c, src = 'model catalog') {
  const fail = (msg) => { throw new Error(`${src}: ${msg}`); };
  if (!c || typeof c !== 'object' || !Array.isArray(c.models) || !c.models.length) fail('needs a non-empty "models" list');
  const aliases = new Map(), ids = new Map();
  const models = c.models.map((m) => {
    if (!m || typeof m !== 'object' || typeof m.alias !== 'string' || !m.alias || typeof m.id !== 'string' || !m.id) fail('every model needs an alias and an id');
    if ('family' in m && !MODEL_FAMILIES.includes(m.family)) fail(`model ${m.alias}: "family" must be one of ${MODEL_FAMILIES.join(', ')}`);
    if ('pin' in m && typeof m.pin !== 'boolean') fail(`model ${m.alias}: "pin" must be true or false`);
    if ('enabled' in m && typeof m.enabled !== 'boolean') fail(`model ${m.alias}: "enabled" must be true or false`);
    if (aliases.has(m.alias.toLowerCase())) fail(`model aliases must be unique ("${m.alias}" is used twice)`);
    if (ids.has(m.id)) fail(`model ids must be unique ("${m.id}" is used twice)`);
    aliases.set(m.alias.toLowerCase(), m); ids.set(m.id, m);
    const enabled = m.enabled !== false, family = familyOf(m);
    if (m.pin === true && family === null) fail(`model ${m.alias} is pinned but has no family; add "family": "sonnet", "opus" or "haiku"`);
    if (m.pin === true && !enabled) fail(`model ${m.alias} is pinned but disabled; a pinned model must be enabled`);
    const pinned = enabled && (typeof m.pin === 'boolean' ? m.pin : family !== null && family === m.alias.toLowerCase());
    return { tier: 'default', ...m, enabled, family, pinned, pricePerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null, ...(m.pricePerMTok || {}) } };
  });
  const pins = new Map();
  for (const m of models) if (m.pinned) pins.set(m.family, [...(pins.get(m.family) || []), m.alias]);
  for (const [f, names] of pins) if (names.length > 1) fail(`more than one model pins the ${f} family (${names.join(', ')}). Only one may; set "pin": false on the others (to make a newer or older version the default, give it "pin": true and the current one "pin": false).`);
  let dflt = c.default;
  if (!Object.hasOwn(c, 'default')) dflt = models.find((m) => m.enabled)?.alias;     // absent = the first enabled entry; present but null/empty is refused (installer and Terraform refuse it too)
  else {
    const hit = typeof dflt === 'string' ? aliases.get(dflt.toLowerCase()) || ids.get(dflt) : null;
    if (!hit) fail(`"default" must be the alias or id of a model in the list (got "${String(dflt).slice(0, 60)}")`);
    if (hit.enabled === false) fail(`the default model "${dflt}" must be enabled`);
    dflt = hit.alias;
  }
  if (!models.some((m) => m.enabled)) fail('has no enabled models');
  // Not an error, but almost always a half-applied change: a family has an enabled entry yet nothing pins it, so on Vertex `/model <family>` resolves to
  // Claude Code's own default for that family, which is not in availableModels (the request is refused). Shown on /api/models and logged at start-up.
  const warnings = [];
  for (const f of MODEL_FAMILIES) {
    const names = models.filter((m) => m.enabled && m.family === f).map((m) => m.alias);
    if (names.length && !pins.has(f)) warnings.push(`No enabled model pins the ${f} family: ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} available by name, but the "${f}" alias is not set for anyone, so \`/model ${f}\` will be refused. Set "pin": true on one ${f} entry.`);
  }
  return { default: dflt, models, warnings };
}

export function loadCatalog(env = process.env) {
  let raw = null, src = 'model catalog';
  if (env.MODELS_JSON) { src = 'MODELS_JSON'; try { raw = JSON.parse(env.MODELS_JSON); } catch { throw new Error('MODELS_JSON is not valid JSON'); } }
  else {
    const f = env.MODELS_FILE || path.join(ROOT, 'config', 'models.json');
    if (fs.existsSync(f)) { src = f; try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error(`${f} is not valid JSON`); } }
  }
  return normalizeCatalog(raw || BUILTIN_CATALOG, src);
}

const MIN_PASSWORD = 12, MIN_SESSION_SECRET = 32;
// Rejects values like 'aaaaaaaaaaaa' or '121212121212': fewer than 6 distinct characters is never a real secret.
const lowEntropy = (v) => new Set(String(v)).size < 6;
// APP_MAX_OVERRIDE_DAYS: a plain positive decimal, 1 to 365. Fractions are allowed (1.5 = 36 hours). Anything else stops start-up.
function parseMaxOverrideDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 90;
  const s = String(raw).trim();
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 365) throw new Error('APP_MAX_OVERRIDE_DAYS must be a number of days between 1 and 365 (fractions allowed, e.g. 1.5)');
  return n;
}

// A cache lifetime in milliseconds: a whole number from 0 (off) to 60000.
function parseCacheMs(raw, name, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim();
  if (!/^\d{1,5}$/.test(s) || Number(s) > 60000) throw new Error(`${name} must be a whole number of milliseconds between 0 and 60000`);
  return Number(s);
}

// IAP: the audience is the exact string IAP puts in the JWT `aud` (Cloud Run direct IAP, or a load balancer's backend service).
const IAP_AUDIENCE_RE = /^\/projects\/[0-9]{1,20}\/(?:locations\/[a-z0-9-]{2,40}\/services\/[a-z][a-z0-9-]{0,62}|global\/backendServices\/[0-9]{1,25})$/;
const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function loadIap(env, inCloud) {
  const audience = String(env.IAP_AUDIENCE || '').trim();
  if (!audience) throw new Error('APP_AUTH_MODE=iap needs IAP_AUDIENCE: /projects/<PROJECT_NUMBER>/locations/<REGION>/services/<NAME> (Cloud Run) or /projects/<PROJECT_NUMBER>/global/backendServices/<ID> (load balancer)');
  if (!IAP_AUDIENCE_RE.test(audience)) throw new Error('IAP_AUDIENCE is not in a known form: /projects/<PROJECT_NUMBER>/locations/<REGION>/services/<NAME> or /projects/<PROJECT_NUMBER>/global/backendServices/<ID> (project NUMBER, not id)');
  const allowedDomains = [...new Set(String(env.IAP_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean))];
  // A list that was set to restrict and parses to nothing (' , ', '') would silently restrict nothing: refuse it. Unset is the way to say "no extra check".
  if (env.IAP_ALLOWED_DOMAINS !== undefined && !allowedDomains.length) throw new Error('IAP_ALLOWED_DOMAINS is set but lists no domain: give a comma list such as example.com, or unset it for no extra check');
  for (const d of allowedDomains) if (!DOMAIN_RE.test(d)) throw new Error(`IAP_ALLOWED_DOMAINS has an invalid domain: ${d.slice(0, 60)}`);
  // The key URL may be overridden only for a local emulator, never on Cloud Run, and only to this machine over plain http.
  let keysUrl = IAP_KEYS_URL;
  const o = String(env.IAP_PUBLIC_KEYS_URL || '').trim();
  if (o) {
    if (inCloud) throw new Error('IAP_PUBLIC_KEYS_URL must not be set on Cloud Run: IAP keys always come from Google');
    let u; try { u = new URL(o); } catch { throw new Error('IAP_PUBLIC_KEYS_URL is not a valid URL'); }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('IAP_PUBLIC_KEYS_URL may only point at http://127.0.0.1, http://localhost or http://[::1] (a local emulator)');
    keysUrl = u.href;
  }
  return { audience, allowedDomains, keysUrl };
}
// GATEWAY_CA_PEM: PEM text for the CA (or self-signed certificate) the gateway's TLS certificate chains to. Literal "\n" sequences are accepted.
function loadCaPem(raw) {
  let pem = String(raw || '').trim();
  if (!pem) return '';
  if (!pem.includes('\n') && pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.join('').replace(/\s/g, '').length < 100) throw new Error('GATEWAY_CA_PEM must contain at least one PEM certificate (-----BEGIN CERTIFICATE-----)');
  if (pem.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g, '').trim()) throw new Error('GATEWAY_CA_PEM may contain only certificates (no private keys or other text)');
  return blocks.join('\n') + '\n';
}

// On Cloud Run the app sends the gateway admin keys (x-api-key) on every call: plain http would put them on the wire in clear. Only a
// loopback host (a sidecar or a local test) may use http there. Locally anything goes, as before.
function checkGatewayUrl(raw, inCloud) {
  if (!inCloud) return;
  let u; try { u = new URL(raw); } catch { throw new Error('GATEWAY_URL is not a valid URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('GATEWAY_URL must be https:// on Cloud Run (the app sends the gateway admin keys); plain http is allowed only for localhost');
}

export function loadConfig(env = process.env) {
  const demo = env.APP_DEMO === '1';
  const inCloud = !!(env.K_SERVICE || env.CLOUD_RUN_JOB);            // set by Cloud Run (services, and jobs such as the tick job)
  // Unset means session (the documented default); set-but-empty is a mistake (an empty template value) and must not silently pick a mode.
  if (env.APP_AUTH_MODE !== undefined && String(env.APP_AUTH_MODE).trim() === '') throw new Error('APP_AUTH_MODE is set but empty: use session or iap (or unset it for session)');
  const authMode = String(env.APP_AUTH_MODE ?? 'session').trim();
  if (authMode !== 'session' && authMode !== 'iap') throw new Error('APP_AUTH_MODE must be session or iap');
  const iapMode = authMode === 'iap';
  // Demo mode has a published admin login. It must never be reachable on a real deployment by accident.
  if (demo && inCloud && env.APP_DEMO_ALLOW_CLOUD !== '1') {
    throw new Error('refusing to start in demo mode on Cloud Run: demo mode has a built-in public admin login. Unset APP_DEMO, or set APP_DEMO_ALLOW_CLOUD=1 if this really is a public demo.');
  }
  const host = env.APP_HOST || '127.0.0.1';
  // "Only available locally": refuse to listen beyond loopback unless this is Cloud Run (private by IAM) or explicitly allowed.
  if (!LOOPBACK.has(host) && !inCloud && env.APP_ALLOW_NON_LOOPBACK !== '1') {
    throw new Error(`refusing to listen on ${host}: this app is local-only. Use 127.0.0.1, or set APP_ALLOW_NON_LOOPBACK=1 if you front it with your own access control.`);
  }

  let admins = [];
  if (env.APP_ADMINS) {
    try { admins = JSON.parse(env.APP_ADMINS); } catch { throw new Error('APP_ADMINS is not valid JSON'); }
    // In iap mode the password is optional (it is never used: the signed IAP identity is the login); when given it is still checked.
    if (!Array.isArray(admins) || admins.some((a) => !a || !a.email || !a.writeKey || (!iapMode && !a.password))) throw new Error(`APP_ADMINS entries need email, ${iapMode ? '' : 'password and '}writeKey`);
    const withPw = admins.filter((a) => a.password !== undefined && a.password !== '');
    if (!demo && withPw.some((a) => typeof a.password !== 'string' || a.password.length < MIN_PASSWORD)) throw new Error(`APP_ADMINS passwords must be at least ${MIN_PASSWORD} characters`);
    if (!demo && withPw.some((a) => lowEntropy(a.password))) throw new Error('APP_ADMINS passwords are too repetitive (use at least 6 different characters)');
    const seen = new Set();
    for (const a of admins) { const e = String(a.email).trim().toLowerCase(); if (seen.has(e)) throw new Error('APP_ADMINS lists the same email twice (emails are compared case-insensitively)'); seen.add(e); }
    admins = admins.map((a) => { const email = String(a.email).trim().toLowerCase(); return { ...a, email, name: a.name || email.split('@')[0] }; });
  }
  if (!demo) {
    if (!env.GATEWAY_ADMIN_READ_KEY) throw new Error('missing GATEWAY_ADMIN_READ_KEY');
    if (iapMode && !admins.length) throw new Error('APP_AUTH_MODE=iap needs APP_ADMINS (email, name, writeKey for each admin): admins are the IAP-verified emails listed there');
    if (!iapMode && !admins.length && !(env.GATEWAY_ADMIN_WRITE_KEY && env.APP_ADMIN_PASSWORD)) throw new Error('set APP_ADMINS, or GATEWAY_ADMIN_WRITE_KEY with APP_ADMIN_PASSWORD (local single-admin mode)');
    if (!iapMode && !admins.length && env.APP_ADMIN_PASSWORD.length < MIN_PASSWORD) throw new Error(`APP_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);
    if (!iapMode && !admins.length && lowEntropy(env.APP_ADMIN_PASSWORD)) throw new Error('APP_ADMIN_PASSWORD is too repetitive (use at least 6 different characters)');
  }
  // On Cloud Run the session secret is its own required secret. Locally it may be derived (domain-separated HMAC) from the gateway's JWT secret.
  let sessionSecret = env.APP_SESSION_SECRET || '';
  if (sessionSecret) {
    if (!demo && sessionSecret.length < MIN_SESSION_SECRET) throw new Error(`APP_SESSION_SECRET must be at least ${MIN_SESSION_SECRET} characters`);
    if (!demo && lowEntropy(sessionSecret)) throw new Error('APP_SESSION_SECRET is too repetitive (use at least 6 different characters)');
  } else if (demo || iapMode) sessionSecret = crypto.randomBytes(32).toString('hex');   // iap mode has no app sessions at all: a throwaway value
  else if (!inCloud && env.GATEWAY_JWT_SECRET) sessionSecret = crypto.createHmac('sha256', env.GATEWAY_JWT_SECRET).update('budget-app:session-secret').digest('hex');
  else throw new Error(`missing APP_SESSION_SECRET (at least ${MIN_SESSION_SECRET} characters${inCloud ? '; required on Cloud Run, there is no fallback' : ''})`);
  // In iap mode the scheduler's own token cannot get through IAP: ticking is done by the Cloud Run job (api/tick.mjs), so these are ignored.
  const schedulerSa = iapMode ? '' : env.SCHEDULER_SA || '', schedulerAudience = iapMode ? '' : env.SCHEDULER_AUDIENCE || '';
  if (schedulerSa && !schedulerAudience) throw new Error('SCHEDULER_SA is set but SCHEDULER_AUDIENCE is not: set it to this service\'s own URL (the audience of the scheduler\'s OIDC token)');

  const iap = iapMode ? loadIap(env, inCloud) : null;
  const gatewayUrl = env.GATEWAY_URL || 'http://localhost:8791';
  checkGatewayUrl(gatewayUrl, inCloud);
  const gatewayCaPem = loadCaPem(env.GATEWAY_CA_PEM);
  const usageSource = env.USAGE_SOURCE || (demo ? 'demo' : env.CLICKHOUSE_PASSWORD ? 'clickhouse' : (inCloud && env.APP_STATE_BUCKET) ? 'logs' : 'none');
  return {
    demo, inCloud, host, authMode, iap,
    port: Number(env.PORT || env.APP_PORT || 8792),
    gatewayUrl,
    gatewayAudience: String(env.GATEWAY_AUDIENCE || '').trim(),   // empty: send no Authorization to the gateway (internal load balancer mode)
    gatewayCaPem,                                                  // optional PEM the gateway call trusts (self-signed or corporate CA)
    gatewayService: env.GATEWAY_SERVICE_NAME || 'claude-gateway',
    // Optional: a Cloud Logging view limited to the gateway's logs (Terraform scope_app_log_access). Without it the app queries the whole project.
    usageLogsView: /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/buckets\/[A-Za-z0-9_-]+\/views\/[A-Za-z0-9_-]+$/.test(env.USAGE_LOGS_VIEW || '') ? env.USAGE_LOGS_VIEW : '',
    readKey: env.GATEWAY_ADMIN_READ_KEY || '',
    writeKey: env.GATEWAY_ADMIN_WRITE_KEY || '',
    systemKey: env.GATEWAY_SYSTEM_WRITE_KEY || '',
    admins, localPassword: admins.length ? '' : (env.APP_ADMIN_PASSWORD || ''),
    sessionSecret,
    viewAccess: env.APP_VIEW_ACCESS === 'admin' ? 'admin' : 'open',   // 'open': data is visible without signing in; changes always need an admin
    usageSource,
    clickhouse: { url: env.CLICKHOUSE_HTTP || 'http://127.0.0.1:18123', password: env.CLICKHOUSE_PASSWORD || '' },
    stateBucket: env.APP_STATE_BUCKET || '', dataDir: env.APP_DATA_DIR || path.join(ROOT, 'data', 'app'),
    schedulerSa, schedulerAudience,
    // The loopback names are always accepted except for an IAP app on Cloud Run, where the only real Hosts are the ones listed (nothing there
    // legitimately says Host: localhost, and accepting it only widens the DNS-rebinding surface). Session mode keeps them for `gcloud run services proxy`.
    loopbackHosts: !(inCloud && iapMode),
    allowedHosts: new Set([...(inCloud && iapMode ? [] : ['localhost', '127.0.0.1']), ...(env.APP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]),
    allowedHostSuffixes: (env.APP_ALLOWED_HOST_SUFFIXES || '').split(',').map((h) => h.trim()).filter(Boolean),
    allowedOrigins: new Set((env.APP_ALLOWED_ORIGINS || '').split(',').map((h) => h.trim()).filter(Boolean)),
    // The Expo dev server (port 8081) may call the API cross-origin only on a developer's machine, and only when asked.
    devOrigins: !inCloud && env.APP_DEV === '1' ? new Set(['http://localhost:8081', 'http://127.0.0.1:8081']) : new Set(),
    dist: path.join(ROOT, 'app', 'dist'),
    catalog: loadCatalog(env),
    readCacheMs: parseCacheMs(env.APP_READ_CACHE_MS, 'APP_READ_CACHE_MS', 8000),
    healthCacheMs: parseCacheMs(env.APP_HEALTH_CACHE_MS, 'APP_HEALTH_CACHE_MS', 10000),
    maxOverrideDays: parseMaxOverrideDays(env.APP_MAX_OVERRIDE_DAYS),
  };
}
