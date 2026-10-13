// All configuration comes from the environment, validated once at start-up. Pure function of `env`, so tests can pass their own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const BUILTIN_CATALOG = {
  default: 'sonnet',
  models: [
    { alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'default', description: 'Everyday coding. The baseline.', enabled: true },
    { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'upgrade', description: 'Hardest problems. Costs more.', enabled: true },
    { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'fast', description: 'Fast and cheap for simple tasks.', enabled: true },
  ],
};

export function loadCatalog(env = process.env) {
  let raw = null;
  if (env.MODELS_JSON) raw = JSON.parse(env.MODELS_JSON);
  else {
    const f = env.MODELS_FILE || path.join(ROOT, 'config', 'models.json');
    if (fs.existsSync(f)) raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const c = raw || BUILTIN_CATALOG;
  const models = (c.models || []).filter((m) => m.id && m.alias).map((m) => ({ enabled: true, tier: 'default', ...m, pricePerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null, ...(m.pricePerMTok || {}) } }));
  return { default: c.default || models[0]?.alias, models };
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

export function loadConfig(env = process.env) {
  const demo = env.APP_DEMO === '1';
  const inCloud = !!env.K_SERVICE;                                   // set by Cloud Run
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
    if (!Array.isArray(admins) || admins.some((a) => !a.email || !a.password || !a.writeKey)) throw new Error('APP_ADMINS entries need email, password and writeKey');
    if (!demo && admins.some((a) => typeof a.password !== 'string' || a.password.length < MIN_PASSWORD)) throw new Error(`APP_ADMINS passwords must be at least ${MIN_PASSWORD} characters`);
    if (!demo && admins.some((a) => lowEntropy(a.password))) throw new Error('APP_ADMINS passwords are too repetitive (use at least 6 different characters)');
    const seen = new Set();
    for (const a of admins) { const e = String(a.email).trim().toLowerCase(); if (seen.has(e)) throw new Error('APP_ADMINS lists the same email twice (emails are compared case-insensitively)'); seen.add(e); }
    admins = admins.map((a) => ({ ...a, email: String(a.email).toLowerCase(), name: a.name || String(a.email).split('@')[0] }));
  }
  if (!demo) {
    if (!env.GATEWAY_ADMIN_READ_KEY) throw new Error('missing GATEWAY_ADMIN_READ_KEY');
    if (!admins.length && !(env.GATEWAY_ADMIN_WRITE_KEY && env.APP_ADMIN_PASSWORD)) throw new Error('set APP_ADMINS, or GATEWAY_ADMIN_WRITE_KEY with APP_ADMIN_PASSWORD (local single-admin mode)');
    if (!admins.length && env.APP_ADMIN_PASSWORD.length < MIN_PASSWORD) throw new Error(`APP_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);
    if (!admins.length && lowEntropy(env.APP_ADMIN_PASSWORD)) throw new Error('APP_ADMIN_PASSWORD is too repetitive (use at least 6 different characters)');
  }
  // On Cloud Run the session secret is its own required secret. Locally it may be derived (domain-separated HMAC) from the gateway's JWT secret.
  let sessionSecret = env.APP_SESSION_SECRET || '';
  if (sessionSecret) {
    if (!demo && sessionSecret.length < MIN_SESSION_SECRET) throw new Error(`APP_SESSION_SECRET must be at least ${MIN_SESSION_SECRET} characters`);
    if (!demo && lowEntropy(sessionSecret)) throw new Error('APP_SESSION_SECRET is too repetitive (use at least 6 different characters)');
  } else if (demo) sessionSecret = crypto.randomBytes(32).toString('hex');
  else if (!inCloud && env.GATEWAY_JWT_SECRET) sessionSecret = crypto.createHmac('sha256', env.GATEWAY_JWT_SECRET).update('budget-app:session-secret').digest('hex');
  else throw new Error(`missing APP_SESSION_SECRET (at least ${MIN_SESSION_SECRET} characters${inCloud ? '; required on Cloud Run, there is no fallback' : ''})`);
  const schedulerSa = env.SCHEDULER_SA || '', schedulerAudience = env.SCHEDULER_AUDIENCE || '';
  if (schedulerSa && !schedulerAudience) throw new Error('SCHEDULER_SA is set but SCHEDULER_AUDIENCE is not: set it to this service\'s own URL (the audience of the scheduler\'s OIDC token)');

  const usageSource = env.USAGE_SOURCE || (demo ? 'demo' : env.CLICKHOUSE_PASSWORD ? 'clickhouse' : (inCloud && env.APP_STATE_BUCKET) ? 'logs' : 'none');
  return {
    demo, inCloud, host,
    port: Number(env.PORT || env.APP_PORT || 8792),
    gatewayUrl: env.GATEWAY_URL || 'http://localhost:8791',
    gatewayAudience: env.GATEWAY_AUDIENCE || '',
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
    allowedHosts: new Set(['localhost', '127.0.0.1', ...(env.APP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]),
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
