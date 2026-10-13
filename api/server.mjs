// Budget tracker backend. Holds the gateway admin keys so the browser never sees them,
// reads usage from ClickHouse, reads and writes caps through the gateway admin API,
// and serves the built web app. No dependencies; Node 20+.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`missing env ${k} (run via scripts/run-app.sh)`); process.exit(1); } return env[k]; };

const PORT = Number(env.PORT || env.APP_PORT || 8792);
const HOST = env.APP_HOST || '127.0.0.1';                       // Cloud Run sets APP_HOST=0.0.0.0
const GATEWAY = env.GATEWAY_URL || 'http://localhost:8791';
const CH_URL = env.CLICKHOUSE_HTTP || 'http://127.0.0.1:18123';
const CH_PASS = env.CLICKHOUSE_PASSWORD || '';
const USAGE = !!CH_PASS;                       // without ClickHouse the app still manages budgets; usage views stay empty
const GATEWAY_AUDIENCE = env.GATEWAY_AUDIENCE || '';   // set on Cloud Run: the gateway service URL (needs an ID token)
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', ...(env.APP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);
const ALLOWED_HOST_SUFFIXES = (env.APP_ALLOWED_HOST_SUFFIXES || '').split(',').map((h) => h.trim()).filter(Boolean);   // e.g. .run.app
const ALLOWED_ORIGINS = new Set((env.APP_ALLOWED_ORIGINS || '').split(',').map((h) => h.trim()).filter(Boolean));
const READ_KEY = need('GATEWAY_ADMIN_READ_KEY');
// Admin accounts. Production: APP_ADMINS = JSON [{email, name, password, writeKey}] (Terraform generates it). Each admin has
// their own gateway write key, so the gateway's audit trail names the person who changed a cap.
// Local dev: a single shared APP_ADMIN_PASSWORD with GATEWAY_ADMIN_WRITE_KEY (actor shows as that key's id).
let ADMINS = [];
if (env.APP_ADMINS) {
  try { ADMINS = JSON.parse(env.APP_ADMINS); } catch { console.error('APP_ADMINS is not valid JSON'); process.exit(1); }
  if (!Array.isArray(ADMINS) || ADMINS.some((a) => !a.email || !a.password || !a.writeKey)) { console.error('APP_ADMINS entries need email, password and writeKey'); process.exit(1); }
  ADMINS = ADMINS.map((a) => ({ ...a, email: String(a.email).toLowerCase(), name: a.name || String(a.email).split('@')[0] }));
}
const WRITE_KEY = ADMINS.length ? '' : need('GATEWAY_ADMIN_WRITE_KEY');
const APP_PASSWORD = ADMINS.length ? '' : need('APP_ADMIN_PASSWORD');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const SECRET = crypto.createHash('sha256').update('budget-app:' + (env.APP_SESSION_SECRET || need('GATEWAY_JWT_SECRET'))).digest();
const DEMO = env.DEMO_SPEND === '1';           // dev only: overlays fake spend so the UI can be inspected
const DEV_ORIGINS = new Set(['http://localhost:8081', 'http://127.0.0.1:8081']);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'dist');

const PERIODS = ['weekly', 'monthly'];           // what the app edits
const SHOWN = ['daily', 'weekly', 'monthly'];    // what it displays (daily is read-only here)
const RANGES = { '24h': { s: 86400, b: 3600 }, '7d': { s: 7 * 86400, b: 6 * 3600 }, '30d': { s: 30 * 86400, b: 86400 } };
const DATA = { all: '1', real: 'NOT is_load_test', loadtest: 'is_load_test' };
const SUB_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_USD = 100000;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- gateway admin API ----------
let idToken = { value: '', exp: 0 };
async function gatewayAuthHeader() {
  if (!GATEWAY_AUDIENCE) return {};
  if (Date.now() > idToken.exp) {       // Cloud Run service-to-service: ID token from the metadata server
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(GATEWAY_AUDIENCE),
      { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) { console.error('metadata identity token failed:', r.status, (await r.text()).slice(0, 200)); throw new HttpError(502, 'could not get a service identity token'); }
    idToken = { value: await r.text(), exp: Date.now() + 45 * 60e3 };
  }
  return { authorization: 'Bearer ' + idToken.value };
}
async function gw(method, p, { body, write = false, key = '' } = {}) {
  const r = await fetch(GATEWAY + '/v1/organizations/spend_limits' + p, {
    method,
    headers: { ...(await gatewayAuthHeader()), 'x-api-key': write ? (key || WRITE_KEY) : READ_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) throw new HttpError(r.status === 401 || r.status === 403 ? 502 : r.status, json?.error?.message || `gateway ${r.status}`);
  return json;
}
async function listLimits() {
  const out = []; let after = '';
  for (let i = 0; i < 20; i++) {
    const j = await gw('GET', `?limit=1000${after}`);
    out.push(...j.data);
    if (!j.has_more) break;
    after = `&after_id=${j.last_id}`;
  }
  return out;
}
async function effective(subs, periods = SHOWN) {
  const rows = [];
  for (let i = 0; i < subs.length; i += 50) {
    const q = [...subs.slice(i, i + 50).map((s) => 'user_ids%5B%5D=' + encodeURIComponent(s)),
               ...periods.map((p) => 'period%5B%5D=' + p), 'limit=1000'].join('&');
    rows.push(...(await gw('GET', '/effective?' + q)).data);
  }
  return rows;
}

// ---------- ClickHouse ----------
async function ch(sql) {
  if (!USAGE) return [];
  const r = await fetch(`${CH_URL}/?database=otel&user=otel&password=${encodeURIComponent(CH_PASS)}&default_format=JSON`,
    { method: 'POST', body: sql, signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  if (!r.ok) throw new HttpError(502, 'usage store error: ' + t.slice(0, 200));
  return JSON.parse(t).data;
}
function win(q) {
  const range = RANGES[q.get('range')] ? q.get('range') : '7d';
  const { s, b } = RANGES[range];
  const data = DATA[q.get('data')] ? q.get('data') : 'all';
  const n = Math.ceil(s / b);
  const end = Math.ceil(Date.now() / 1000 / b) * b;   // align buckets to epoch multiples
  const start = end - n * b;
  return { range, data, filter: DATA[data], n, b, start, end };
}
const bucketIdx = (w) => `intDiv(toUnixTimestamp(ts) - ${w.start}, ${w.b})`;
const zeros = (n) => Array(n).fill(0);
const iso = (w) => Array.from({ length: w.n }, (_, i) => new Date((w.start + i * w.b) * 1000).toISOString());

async function effectiveAll() {      // principals with recorded spend; the gateway can't enumerate other members
  const rows = []; let page = '';
  for (let i = 0; i < 20; i++) {
    const j = await gw('GET', '/effective?' + SHOWN.map((p) => 'period%5B%5D=' + p).join('&') + '&limit=1000' + page);
    rows.push(...j.data);
    if (!j.next_page) break;
    page = '&page=' + encodeURIComponent(j.next_page);
  }
  return rows;
}

// ---------- helpers ----------
const cents = (v) => (v === null || v === undefined ? null : Number(v));
function demoSpend(sub, period, cap) {
  if (!DEMO) return null;
  const h = parseInt(crypto.createHash('md5').update(sub + period).digest('hex').slice(0, 6), 16);
  const base = cap ?? (period === 'weekly' ? 5000 : 20000);
  return Math.round(base * (0.08 + (h % 100) / 100 * 0.95));   // some under, some over
}
function budgetsFor(sub, rows) {
  const b = {};
  for (const p of SHOWN) {
    const r = rows.find((x) => x.scope?.user_id === sub && x.period === p);
    const cap = r ? cents(r.amount) : null;
    const spend = demoSpend(sub, p, cap) ?? (r ? Number(r.period_to_date_spend) : 0);
    b[p] = { capCents: cap, spendCents: spend, source: r?.source?.type ?? null, limitId: r?.spend_limit_id ?? null,
             unlimited: r ? r.amount === null && r.source !== null : false };
  }
  return b;
}
function describeEvent(e, names) {
  const snap = e.after || e.before || {};
  const sc = snap.scope || {};
  const who = sc.type === 'user' ? (names.get(sc.user_id) || sc.user_id)
            : sc.type === 'organization' ? 'Everyone (default)' : `Group ${sc.rbac_group_id}`;
  const from = e.before ? cents(e.before.amount) : undefined;
  const to = e.after ? cents(e.after.amount) : undefined;
  let kind = 'changed';
  if (!e.after) kind = 'removed';
  else if (!e.before) kind = to === null ? 'unlimited' : 'created';
  else if (to === null) kind = 'unlimited';
  else if (from === null || to > from) kind = 'raised';
  else if (to < from) kind = 'lowered';
  else kind = 'unchanged';
  return { id: Number(e.id), at: e.created_at, actor: String(e.actor).replace('admin-key:', ''), kind, scopeType: sc.type,
           sub: sc.user_id || null, who, period: snap.period, fromCents: from ?? null, toCents: to ?? null, hadBefore: !!e.before };
}
async function roster() {
  const rows = await ch(`SELECT sub, anyLast(email) AS email FROM v_gateway_requests WHERE sub != '' GROUP BY sub`);
  return new Map(rows.map((r) => [r.sub, r.email]));
}

// ---------- handlers ----------
async function usersList(q) {
  const w = win(q);
  const base = await ch(`
    SELECT sub, anyLast(email) AS email, count() AS total,
           countIf(ts >= toDateTime(${w.start})) AS requests,
           countIf(ts >= toDateTime(${w.start}) AND outcome = 'ok') AS ok,
           max(ts) AS last_seen,
           arrayStringConcat(arrayFilter(m -> m != '', groupUniqArrayIf(model, ts >= toDateTime(${w.start}))), ',') AS models
    FROM v_gateway_requests WHERE sub != '' AND ${w.filter} GROUP BY sub`);
  const sparkRows = await ch(`
    SELECT sub, ${bucketIdx(w)} AS bi, count() AS c FROM v_gateway_requests
    WHERE sub != '' AND ts >= toDateTime(${w.start}) AND ${w.filter} GROUP BY sub, bi`);
  const spark = new Map();
  for (const r of sparkRows) {
    if (!spark.has(r.sub)) spark.set(r.sub, zeros(w.n));
    const i = Number(r.bi); if (i >= 0 && i < w.n) spark.get(r.sub)[i] = Number(r.c);
  }
  const limits = await listLimits();
  const subs = new Set(base.map((r) => r.sub));
  for (const l of limits) if (l.scope.type === 'user') subs.add(l.scope.user_id);
  if (!USAGE) for (const r of await effectiveAll()) if (r.scope?.user_id) subs.add(r.scope.user_id);
  const eff = subs.size ? await effective([...subs]) : [];
  const byBase = new Map(base.map((r) => [r.sub, r]));
  const users = [...subs].map((sub) => {
    const r = byBase.get(sub); const actor = eff.find((x) => x.scope?.user_id === sub)?.actor;
    const email = r?.email || actor?.email_address || null;
    return {
      sub, email, name: actor?.name || (email ? email.split('@')[0] : sub.slice(0, 8)),
      requests: Number(r?.requests || 0), ok: Number(r?.ok || 0), failed: Number(r?.requests || 0) - Number(r?.ok || 0),
      lastSeen: r?.last_seen ? new Date(r.last_seen.replace(' ', 'T') + 'Z').toISOString() : null,
      models: r?.models ? r.models.split(',') : [], spark: spark.get(sub) || zeros(w.n),
      budgets: budgetsFor(sub, eff),
    };
  });
  return { range: w.range, data: w.data, demo: DEMO, usageConnected: USAGE, buckets: iso(w), users };
}

async function userDetail(sub, q) {
  if (!SUB_RE.test(sub)) throw new HttpError(400, 'bad user id');
  const w = win(q);
  const where = `sub = '${sub}' AND ts >= toDateTime(${w.start}) AND ${w.filter}`;
  const [series, models, recent] = await Promise.all([
    ch(`SELECT ${bucketIdx(w)} AS bi, if(model = '', '(none)', model) AS model, count() AS c FROM v_gateway_requests WHERE ${where} GROUP BY bi, model`),
    ch(`SELECT if(model = '', '(none)', model) AS model, count() AS requests, countIf(outcome = 'ok') AS ok,
               round(quantileIf(0.5)(latency_ms, outcome = 'ok')) AS p50 FROM v_gateway_requests WHERE ${where} GROUP BY model ORDER BY requests DESC`),
    ch(`SELECT r.ts AS ts, r.request_id AS id, if(r.model = '', '(none)', r.model) AS model, r.outcome AS outcome, r.status AS status,
               r.latency_ms AS ms, u.cause AS cause FROM v_gateway_requests r LEFT JOIN v_upstream_errors u ON u.request_id = r.request_id
        WHERE r.sub = '${sub}' AND ${w.filter.replace(/is_load_test/g, 'r.is_load_test')} ORDER BY r.ts DESC LIMIT 25`),
  ]);
  const names = [...new Set(series.map((r) => r.model))];
  const values = Object.fromEntries(names.map((m) => [m, zeros(w.n)]));
  for (const r of series) { const i = Number(r.bi); if (i >= 0 && i < w.n) values[r.model][i] = Number(r.c); }
  const eff = await effective([sub]);
  const all = await listLimits();
  const limits = all.filter((l) => l.scope.type === 'user' && l.scope.user_id === sub);
  const orgDefaults = Object.fromEntries(all.filter((l) => l.scope.type === 'organization').map((l) => [l.period, cents(l.amount)]));
  const audit = (await gw('GET', '/audit?limit=200')).data.filter((e) => (e.after || e.before)?.scope?.user_id === sub);
  const actor = eff.find((x) => x.actor)?.actor;
  const email = actor?.email_address || (await roster()).get(sub) || null;
  return {
    demo: DEMO, usageConnected: USAGE, range: w.range, data: w.data, buckets: iso(w), bucketSeconds: w.b,
    orgDefaults,
    user: { sub, email, name: actor?.name || (email ? email.split('@')[0] : sub.slice(0, 8)), budgets: budgetsFor(sub, eff),
            ownLimits: Object.fromEntries(limits.map((l) => [l.period, { id: l.id, amountCents: cents(l.amount) }])) },
    series: { models: names, values },
    models: models.map((m) => ({ model: m.model, requests: Number(m.requests), ok: Number(m.ok), p50: Number(m.p50) || null })),
    recent: recent.map((r) => ({ ts: new Date(r.ts.replace(' ', 'T') + 'Z').toISOString(), id: r.id, model: r.model, outcome: r.outcome,
                                  status: Number(r.status), ms: Number(r.ms), cause: r.cause || null })),
    audit: audit.map((e) => describeEvent(e, new Map([[sub, email || sub]]))),
  };
}

function parseBudgetBody(b, allowUnlimited) {
  if (!b || !PERIODS.includes(b.period)) throw new HttpError(400, 'period must be weekly or monthly');
  if (b.action === 'inherit') return { action: 'inherit' };
  if (b.action === 'unlimited') { if (!allowUnlimited) throw new HttpError(400, 'not allowed here'); return { action: 'unlimited' }; }
  if (b.action === 'set') {
    const usd = Number(b.usd);
    if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD) throw new HttpError(400, `amount must be between 0 and ${MAX_USD}`);
    return { action: 'set', cents: Math.round(usd * 100) };
  }
  throw new HttpError(400, 'action must be set, unlimited or inherit');
}
async function applyBudget(scope, b, allowUnlimited, who) {
  const p = parseBudgetBody(b, allowUnlimited);
  if (p.action === 'inherit') {
    const mine = (await listLimits()).find((l) => l.period === b.period && l.scope.type === scope.type && (l.scope.user_id || '') === (scope.user_id || ''));
    if (mine) await gw('DELETE', '/' + mine.id, { write: true, key: who.writeKey });
    console.log(JSON.stringify({ evt: 'budget.change', by: who.email, scope, period: b.period, action: 'inherit' }));
    return { ok: true, removed: !!mine };
  }
  console.log(JSON.stringify({ evt: 'budget.change', by: who.email, scope, period: b.period, action: p.action, cents: p.cents ?? null }));
  const saved = await gw('POST', '', { write: true, key: who.writeKey, body: { scope, period: b.period, amount: p.action === 'unlimited' ? null : String(p.cents) } });
  return { ok: true, limit: saved };
}

async function company(q) {
  const w = win(q);
  const [tot, byUser, byModel, series] = await Promise.all([
    ch(`SELECT count() AS requests, countIf(outcome='ok') AS ok, countIf(outcome='upstream_error') AS upstream_errors,
               countIf(outcome='spend_cap') AS blocked, countIf(outcome='rejected') AS rejected, uniqExactIf(sub, sub != '') AS users
        FROM v_gateway_requests WHERE ts >= toDateTime(${w.start}) AND ${w.filter}`),
    ch(`SELECT sub, anyLast(email) AS email, count() AS c FROM v_gateway_requests WHERE sub != '' AND ts >= toDateTime(${w.start}) AND ${w.filter} GROUP BY sub ORDER BY c DESC`),
    ch(`SELECT if(model = '', '(none)', model) AS model, count() AS requests, countIf(outcome='ok') AS ok
        FROM v_gateway_requests WHERE ts >= toDateTime(${w.start}) AND ${w.filter} GROUP BY model ORDER BY requests DESC`),
    ch(`SELECT ${bucketIdx(w)} AS bi, sub, count() AS c FROM v_gateway_requests WHERE sub != '' AND ts >= toDateTime(${w.start}) AND ${w.filter} GROUP BY bi, sub`),
  ]);
  const limits = await listLimits();
  const orgLimits = Object.fromEntries(limits.filter((l) => l.scope.type === 'organization').map((l) => [l.period, { id: l.id, amountCents: cents(l.amount) }]));
  const userLimits = limits.filter((l) => l.scope.type === 'user');
  if (!USAGE) {
    const known = new Set(userLimits.map((l) => l.scope.user_id));
    for (const r of await effectiveAll()) if (r.scope?.user_id) known.add(r.scope.user_id);
    for (const sub of known) if (!byUser.some((u) => u.sub === sub)) byUser.push({ sub, email: null, c: 0 });
  }
  const subs = byUser.map((u) => u.sub);
  const eff = subs.length ? await effective(subs) : [];
  const totals = {};
  for (const p of PERIODS) {
    let spend = 0, committed = 0, uncapped = 0;
    for (const sub of subs) { const b = budgetsFor(sub, eff)[p]; spend += b.spendCents; if (b.capCents === null) uncapped++; else committed += b.capCents; }
    totals[p] = { spendCents: spend, committedCents: committed, uncappedUsers: uncapped };
  }
  const values = Object.fromEntries(subs.map((s) => [s, zeros(w.n)]));
  for (const r of series) { const i = Number(r.bi); if (i >= 0 && i < w.n && values[r.sub]) values[r.sub][i] = Number(r.c); }
  return {
    demo: DEMO, usageConnected: USAGE, range: w.range, data: w.data, buckets: iso(w),
    totals: Object.fromEntries(Object.entries(tot[0] || { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 }).map(([k, v]) => [k, Number(v)])),
    org: orgLimits, userOverrides: userLimits.length, seats: subs.length, spend: totals,
    users: byUser.map((u) => ({ sub: u.sub, email: u.email, requests: Number(u.c) })), series: values,
    models: byModel.map((m) => ({ model: m.model, requests: Number(m.requests), ok: Number(m.ok) })),
  };
}

async function auditList(q) {
  const names = await roster();
  const j = await gw('GET', `/audit?limit=${Math.min(Number(q.get('limit')) || 100, 500)}`);
  return { events: j.data.map((e) => describeEvent(e, names)) };
}

// ---------- auth + routing ----------
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const mint = (email, name) => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3, email, name })).toString('base64url'); return p + '.' + sign(p); };
function authed(req) {
  // x-app-token first: behind Cloud Run IAM / `gcloud run services proxy` the Authorization header carries Google's identity token.
  const t = String(req.headers['x-app-token'] || req.headers.authorization || '').replace(/^Bearer /, ''); const [p, s] = t.split('.');
  if (!p || !s) return false;
  const good = Buffer.from(sign(p)); const got = Buffer.from(s);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return false;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d : false; } catch { return false; }
}
// The signed-in admin: their own gateway key when accounts are configured, else the shared local key.
const whoIs = (sess) => { const a = ADMINS.find((x) => x.email === sess.email); return a ? { email: a.email, name: a.name, writeKey: a.writeKey } : { email: sess.email || 'local-admin', name: sess.name || 'Admin', writeKey: WRITE_KEY }; };
let failures = [];
const send = (res, status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 20000) { no(new HttpError(413, 'too large')); req.destroy(); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new HttpError(400, 'bad json')); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.map': 'application/json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(DIST, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(DIST)) return send(res, 400, { error: 'bad path' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('App not built yet. Run: cd app && npx expo export -p web'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const host = (req.headers.host || '').split(':')[0];
  if (!ALLOWED_HOSTS.has(host) && !ALLOWED_HOST_SUFFIXES.some((x) => host.endsWith(x))) return send(res, 400, { error: 'bad host' });   // DNS-rebinding guard
  const origin = req.headers.origin;
  const cors = origin && DEV_ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, x-app-token, content-type', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', vary: 'origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
  try {
    if (origin && !DEV_ORIGINS.has(origin) && !ALLOWED_ORIGINS.has(origin) && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'cross-origin request refused');
    const r = url.pathname, q = url.searchParams;
    if (r === '/api/health') {
      const [g, c] = await Promise.allSettled([gatewayAuthHeader().then((h) => fetch(GATEWAY + '/protocol', { headers: h, signal: AbortSignal.timeout(3000) })), ch('SELECT 1 AS x')]);
      if (g.status === 'rejected') console.error('health: gateway unreachable:', g.reason?.message || g.reason);
      else if (!g.value.ok) console.error('health: gateway answered', g.value.status);
      return send(res, 200, { gateway: g.status === 'fulfilled' && g.value.ok, usage: USAGE ? c.status === 'fulfilled' : null, demo: DEMO, accounts: ADMINS.length > 0 }, cors);
    }
    if (r === '/api/login' && req.method === 'POST') {
      failures = failures.filter((t) => Date.now() - t < 60000);
      if (failures.length >= 5) throw new HttpError(429, 'too many attempts, wait a minute');
      const { email = '', password = '' } = await readBody(req);
      let who = null;
      if (ADMINS.length) {                 // always compare, so timing doesn't reveal whether the email exists
        const acct = ADMINS.find((x) => x.email === String(email).trim().toLowerCase());
        const good = crypto.timingSafeEqual(sha(password), sha(acct ? acct.password : crypto.randomBytes(16).toString('hex')));
        if (acct && good) who = { email: acct.email, name: acct.name };
      } else if (crypto.timingSafeEqual(sha(password), sha(APP_PASSWORD))) who = { email: 'local-admin', name: 'Admin' };
      if (!who) { failures.push(Date.now()); throw new HttpError(401, ADMINS.length ? 'wrong email or password' : 'wrong password'); }
      console.log(JSON.stringify({ evt: 'admin.login', email: who.email }));
      return send(res, 200, { token: mint(who.email, who.name), email: who.email, name: who.name }, cors);
    }
    const sess = authed(req);
    if (!sess) throw new HttpError(401, 'sign in required');
    const me = whoIs(sess);
    let m;
    if (r === '/api/users' && req.method === 'GET') return send(res, 200, await usersList(q), cors);
    if ((m = r.match(/^\/api\/users\/([^/]+)$/)) && req.method === 'GET') return send(res, 200, await userDetail(m[1], q), cors);
    if ((m = r.match(/^\/api\/users\/([^/]+)\/budget$/)) && req.method === 'PUT') {
      if (!SUB_RE.test(m[1])) throw new HttpError(400, 'bad user id');
      return send(res, 200, await applyBudget({ type: 'user', user_id: m[1] }, await readBody(req), true, me), cors);
    }
    if (r === '/api/company' && req.method === 'GET') return send(res, 200, await company(q), cors);
    if (r === '/api/org/budget' && req.method === 'PUT') return send(res, 200, await applyBudget({ type: 'organization' }, await readBody(req), false, me), cors);
    if (r === '/api/audit' && req.method === 'GET') return send(res, 200, await auditList(q), cors);
    throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' }, cors);
  }
}).listen(PORT, HOST, () => console.log(`budget app on ${HOST}:${PORT}${USAGE ? '' : '  [no usage store]'}${DEMO ? '  [DEMO SPEND ON]' : ''}`));
