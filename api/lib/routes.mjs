// HTTP layer: builds the app from a config and its dependencies, and serves the JSON API plus the built web app.
// `createApp(cfg, deps)` returns { server, tick, close, ... }; the caller listens, so tests can use any port and inject a clock.
import http from 'node:http';
import net from 'node:net';
import { HttpError, send, serveStatic } from './http.mjs';
import { createAuth } from './auth.mjs';
import { createOverrides } from './overrides.mjs';
import { StoreError } from './store.mjs';
import { buildCoach } from './coach.mjs';
import { createHttpGateway, createMemoryGateway } from './gateway.mjs';
import { createStore } from './store.mjs';
import { createUsage } from './usage/index.mjs';
import { DEMO_ORG, DEMO_USERS } from './demo-users.mjs';

const PERIODS = ['weekly', 'monthly'];            // what the app edits
const SHOWN = ['daily', 'weekly', 'monthly'];     // what it displays (daily is read-only here)
const RANGES = { '24h': { s: 86400, b: 3600 }, '7d': { s: 7 * 86400, b: 6 * 3600 }, '30d': { s: 30 * 86400, b: 86400 } };
const DATA = ['all', 'real', 'loadtest'];
const SUB_RE = /^[A-Za-z0-9_-]{1,200}$/;
const OVERRIDE_ID_RE = /^ovr_[0-9a-f]{12}$/;
const MAX_USD = 100000, BODY_LIMIT = 20000;
const AUDIT_DEPTH = 500;                                   // the gateway's audit endpoint returns at most 500 events and cannot be paged
const READ_CACHE_MS = 8e3, HEALTH_CACHE_MS = 10e3, CACHE_MAX = 300;
const MAX_WORK = 4, RESERVED_WORK = 1, ANON_QUEUE = 48, ADMIN_QUEUE = 16;   // one worker and 16 queue slots are kept for signed-in admins
const LONG_TARGET = 2048;
const HOST_RE = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9-]+(?:\.[a-z0-9-]+)*))(?::([0-9]{1,5}))?$/i;
const LAZY_TICK_MS = 30e3, TIMER_TICK_MS = 60e3;
const API_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };

const cents = (v) => (v === null || v === undefined ? null : Number(v));
const zeros = (n) => Array(n).fill(0);

// ---------- demo gateway: the in-memory twin seeded from the fictional cast ----------
export function createDemoGateway({ now = () => Date.now() } = {}) {
  let clock = null;
  const gw = createMemoryGateway({ users: DEMO_USERS.map((u) => ({ sub: u.sub, email: u.email, name: u.name })), now: () => clock ?? now() });
  const admin = { key: 'demo-key', actor: 'admin@example.com' };
  const ago = (days) => { clock = now() - days * 86400e3; };
  const run = async () => {
    ago(30);
    await gw.upsert({ type: 'organization' }, 'weekly', DEMO_ORG.weeklyCents, admin);
    await gw.upsert({ type: 'organization' }, 'monthly', DEMO_ORG.monthlyCents, admin);
    const caps = new Map();
    let day = 12;
    for (const u of DEMO_USERS) {
      const b = u.budget;
      const personal = { weekly: b.personal?.weeklyCents ?? null, monthly: b.personal?.monthlyCents ?? null };
      if (b.personal || b.unlimited) {
        ago(day); day = Math.max(1, day - 3);
        for (const p of PERIODS) await gw.upsert({ type: 'user', user_id: u.sub }, p, b.unlimited ? null : personal[p], admin);
      }
      caps.set(u.sub, { weekly: personal.weekly ?? DEMO_ORG.weeklyCents, monthly: personal.monthly ?? DEMO_ORG.monthlyCents });
    }
    // a temporary raise that was later removed, so the history shows more than one kind of event
    ago(2); const tmp = await gw.upsert({ type: 'user', user_id: 'demo-ben' }, 'weekly', 20000, { key: 'demo-key', actor: 'admin@example.com' });
    ago(1); await gw.remove(tmp.id, { key: 'demo-key', actor: 'admin@example.com' });
    clock = null;
    for (const u of DEMO_USERS) for (const p of PERIODS) gw.setSpend(u.sub, p, Math.round(u.budget[p + 'Pct'] * caps.get(u.sub)[p]));
  };
  gw.ready = run();
  return gw;
}

// Real dependencies for a config (used by server.mjs). Tests pass their own to createApp instead.
export async function buildDeps(cfg) {
  const store = createStore(cfg);
  const usage = await createUsage(cfg, { store });
  const gateway = cfg.demo ? createDemoGateway() : createHttpGateway(cfg);
  if (gateway.ready) await gateway.ready;
  return { now: () => Date.now(), store, usage, gateway };
}

const nullUsage = () => ({
  source: 'none', async ok() { return null; }, async roster() { return new Map(); }, async ingest() { return { ingested: 0 }; },
  async users() { return { rows: [], spark: new Map() }; }, async detail() { return { series: { models: [], values: {} }, models: [], recent: [] }; },
  async company() { return { totals: { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 }, byUser: [], byModel: [], series: {} }; },
});

// ---------- request helpers ----------
function readJson(req, limit = BODY_LIMIT) {
  return new Promise((ok, no) => {
    if (Number(req.headers['content-length']) > limit) { req.resume(); return no(new HttpError(413, 'request body too large')); }
    let size = 0, over = false, chunks = [];
    req.on('data', (c) => { size += c.length; if (over) return; if (size > limit) { over = true; chunks = []; no(new HttpError(413, 'request body too large')); } else chunks.push(c); });
    req.on('error', () => no(new HttpError(400, 'bad request')));
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      let v = {};
      try { v = text.trim() ? JSON.parse(text) : {}; } catch { return no(new HttpError(400, 'bad json')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return no(new HttpError(400, 'body must be a JSON object'));
      ok(v);
    });
  });
}
// A money amount as whole cents. Only plain decimals are accepted ('12', 12.5, '12.50'): not '0x10', '1e3', ' ', '', arrays, or fractions of a cent.
function parseCents(v) {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) throw new HttpError(400, `amount must be a plain number between 0 and ${MAX_USD}, such as 12 or 12.50`);
  const frac = m[2] || '';
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new HttpError(400, 'amount cannot have fractions of a cent: use at most 2 decimal places');
  return Number(m[1]) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}
// Override reasons are shown to other admins: drop control characters and the invisible/bidi-override characters that can disguise text.
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
export const cleanReason = (r) => String(r).replace(SPACES, ' ').replace(/[\t\r\n]+/g, ' ').replace(INVISIBLE, '').replace(/(\p{M}{3})\p{M}+/gu, '$1').replace(/ {2,}/g, ' ').trim();
// Upstream error text is shown only to a signed-in admin, and only when it is short and plain.
const SAFE_UPSTREAM = /^[\w .,:'()/-]{1,120}$/;
const CREDENTIALISH = /bearer|eyJ|authorization|x-api-key|https?:\/\//i;   // never repeated, even to an admin
function parseBudgetBody(b, allowUnlimited) {
  if (!PERIODS.includes(b.period)) throw new HttpError(400, 'period must be weekly or monthly');
  if (b.action === 'inherit') return { action: 'inherit' };
  if (b.action === 'unlimited') { if (!allowUnlimited) throw new HttpError(400, 'the company default cannot be unlimited'); return { action: 'unlimited' }; }
  if (b.action === 'set') {
    const cents = parseCents(b.usd);
    if (cents > MAX_USD * 100) throw new HttpError(400, `amount must be between 0 and ${MAX_USD}`);
    return { action: 'set', cents };
  }
  throw new HttpError(400, 'action must be set, unlimited or inherit');
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

export function createApp(cfg, deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((o) => console.log(JSON.stringify(o)));
  const store = deps.store || createStore(cfg);
  const usage = deps.usage || nullUsage();
  const auth = deps.auth || createAuth(cfg, { now, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  // Every gateway failure is tagged as upstream: network errors become a safe 502, and gateway text never reaches an anonymous caller.
  const upstream = (e) => {
    if (e instanceof HttpError) { e.upstream = true; return e; }
    return new HttpError(502, 'gateway unavailable', { upstream: true, headers: { 'retry-after': '5' } });
  };
  const rawGateway = deps.gateway || (cfg.demo ? createDemoGateway({ now }) : createHttpGateway(cfg));
  const gateway = new Proxy(rawGateway, { get(t, k) { const v = t[k]; return typeof v === 'function' ? async (...a) => { try { return await v.apply(t, a); } catch (e) { throw upstream(e); } } : v; } });
  const overrides = deps.overrides || createOverrides({ store, gateway, cfg, now, log });
  const lazyMs = deps.lazyTickMs ?? LAZY_TICK_MS;
  const timerMs = deps.timerTickMs ?? TIMER_TICK_MS;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readTtl = deps.readCacheMs ?? cfg.readCacheMs ?? READ_CACHE_MS, healthTtl = deps.healthCacheMs ?? cfg.healthCacheMs ?? HEALTH_CACHE_MS;

  // ---------- read cache: short-lived, coalesced, bounded; dropped on every write ----------
  let gen = 0, active = 0;
  const cache = new Map(), flights = new Map(), waitAdmin = [], waitAnon = [];
  const invalidate = () => { gen++; cache.clear(); flights.clear(); };
  // At most MAX_WORK expensive computations at once. Anonymous callers may use MAX_WORK - RESERVED_WORK of them and a bounded queue,
  // so a flood of anonymous reads can never push a signed-in admin's dashboard out (admins have their own worker and queue).
  const pump = () => {
    for (;;) {
      let go;
      if (active < MAX_WORK && waitAdmin.length) go = waitAdmin.shift();
      else if (active < MAX_WORK - RESERVED_WORK && waitAnon.length) go = waitAnon.shift();
      else return;
      active++; go();
    }
  };
  async function limited(fn, authed) {
    if (active < (authed ? MAX_WORK : MAX_WORK - RESERVED_WORK)) active++;
    else {
      const q = authed ? waitAdmin : waitAnon;
      if (q.length >= (authed ? ADMIN_QUEUE : ANON_QUEUE)) throw new HttpError(503, 'busy, try again shortly', { headers: { 'retry-after': '2' } });
      await new Promise((go) => q.push(go));          // pump() has already counted this slot
    }
    try { return await fn(); } finally { active--; pump(); }
  }
  function cached(key, compute, authed = false) {
    if (authed) key += '|a';                          // admin requests never share a flight with (or wait in the queue of) anonymous ones
    const hit = cache.get(key);
    if (hit && now() - hit.at < readTtl) return hit.value;
    if (flights.has(key)) return flights.get(key);
    const myGen = gen;
    const p = limited(compute, authed).then((value) => {
      if (gen === myGen && readTtl > 0) { cache.set(key, { at: now(), value }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
      return value;
    }).finally(() => { if (flights.get(key) === p) flights.delete(key); });
    flights.set(key, p);
    return p;
  }
  const memo = (ttl, fn) => {
    let at = -Infinity, val, fl = null;
    return () => (now() - at < ttl ? Promise.resolve(val) : (fl ||= fn().then((v) => { val = v; at = now(); return v; }).finally(() => { fl = null; })));
  };
  async function writing(fn) { invalidate(); try { return await fn(); } finally { invalidate(); } }

  // ---------- data assembly ----------
  const win = (q) => {
    const range = q.get('range') ?? '7d', data = q.get('data') ?? 'all';
    if (!RANGES[range]) throw new HttpError(400, 'range must be 24h, 7d or 30d');
    if (!DATA.includes(data)) throw new HttpError(400, 'data must be all, real or loadtest');
    const { s, b } = RANGES[range];
    const n = Math.ceil(s / b);
    const end = Math.ceil(now() / 1000 / b) * b;   // buckets align to epoch multiples
    return { range, data, n, b, start: end - n * b, end };
  };
  const iso = (w) => Array.from({ length: w.n }, (_, i) => new Date((w.start + i * w.b) * 1000).toISOString());
  const usageInfo = memo(healthTtl, async () => {
    let ok = null;
    try { ok = await Promise.race([usage.ok(), new Promise((r) => setTimeout(() => r(false), 3000).unref())]); } catch { ok = false; }
    return { source: usage.source, ok };
  });
  const gatewayUp = memo(healthTtl, () => Promise.resolve().then(() => gateway.ping()).catch(() => false).then(Boolean));
  // Gateway view of everyone: rows for principals with spend, plus anyone we know of from limits or usage.
  async function effectiveFor(extraSubs = []) {
    const all = await gateway.effectiveAll();
    const have = new Set(all.map((r) => r.scope?.user_id));
    const missing = [...new Set(extraSubs)].filter((s) => s && !have.has(s));
    const rows = missing.length ? all.concat(await gateway.effective(missing)) : all;
    const idx = new Map(), actors = new Map();
    for (const r of rows) {
      const sub = r.scope?.user_id; if (!sub) continue;
      idx.set(sub + '|' + r.period, r);
      if (r.actor && (r.actor.email_address || r.actor.name)) actors.set(sub, r.actor);
    }
    return { rows, idx, actors, subs: new Set([...have, ...missing]) };
  }
  function budgetsFor(sub, idx) {
    const b = {};
    for (const p of SHOWN) {
      const r = idx.get(sub + '|' + p);
      b[p] = { capCents: r ? cents(r.amount) : null, spendCents: r ? Number(r.period_to_date_spend) || 0 : 0, source: r?.source?.type ?? null,
        limitId: r?.spend_limit_id ?? null, unlimited: r ? r.amount === null && !!r.source : false };
    }
    return b;
  }
  const nameOf = (sub, email, actor) => actor?.name || (email ? email.split('@')[0] : sub.slice(0, 8));
  // Everyone the app has heard of, as one cached set: gateway rows, personal limits, the usage roster and boosts.
  const knownSubs = (authed) => cached('known-subs', async () => {
    const [rows, limits, roster, ov] = await Promise.all([gateway.effectiveAll(), gateway.listLimits(), usage.roster(), guardedOverrides({}).then((r) => r.list)]);
    const set = new Set(roster.keys());
    for (const r of rows) if (r.scope?.user_id) set.add(r.scope.user_id);
    for (const l of limits) if (l.scope?.type === 'user') set.add(l.scope.user_id);
    for (const o of ov) set.add(o.sub);
    return set;
  }, authed);
  // READS must outlive a damaged overrides document (the gateway and usage data are still good): answer with no overrides and
  // `overridesError: true`, and log at error level at most once a minute. WRITES that need the store still fail (500) cleanly.
  let lastOvLog = -Infinity;
  const guardedOverrides = async (args, forSub) => {
    try { const l = await overrides.list(args); return { list: forSub ? l.filter((o) => o.sub === forSub) : l, error: false }; }
    catch (e) {
      if (!(e instanceof StoreError)) throw e;
      if (now() - lastOvLog >= 60e3) { lastOvLog = now(); log({ evt: 'overrides.store.error', level: 'error', error: String(e?.message || e).slice(0, 200) }); }
      return { list: [], error: true };
    }
  };
  const liveOverrides = () => guardedOverrides({ status: ['scheduled', 'active'] });

  async function usersList(q) {
    const w = win(q);
    const [u, limits, lo, info] = await Promise.all([usage.users(w), gateway.listLimits(), liveOverrides(), usageInfo()]);
    const eff = await effectiveFor([...u.rows.map((r) => r.sub), ...limits.filter((l) => l.scope.type === 'user').map((l) => l.scope.user_id)]);
    const byUsage = new Map(u.rows.map((r) => [r.sub, r]));
    const subs = new Set([...eff.subs, ...byUsage.keys()]);
    const users = [...subs].map((sub) => {
      const r = byUsage.get(sub), actor = eff.actors.get(sub);
      const email = r?.email || actor?.email_address || null;
      const requests = Number(r?.requests || 0), ok = Number(r?.ok || 0);
      return { sub, email, name: nameOf(sub, email, actor), requests, ok, failed: requests - ok, lastSeen: r?.lastSeen || null, models: r?.models || [],
        spark: u.spark.get(sub) || zeros(w.n), budgets: budgetsFor(sub, eff.idx), overrides: lo.list.filter((o) => o.sub === sub) };
    }).sort((a, b) => b.requests - a.requests || String(a.email || a.sub).localeCompare(String(b.email || b.sub)));
    return { range: w.range, data: w.data, demo: cfg.demo, usage: info, buckets: iso(w), users, ...(lo.error ? { overridesError: true } : {}) };
  }

  async function userDetail(sub, q) {
    if (!SUB_RE.test(sub)) throw new HttpError(400, 'bad user id');
    const w = win(q);
    const [eff, limits, d, roster, ovr, info, events] = await Promise.all([
      gateway.effective([sub]), gateway.listLimits(), usage.detail(sub, w), usage.roster(), guardedOverrides({}, sub), usageInfo(), gateway.audit(AUDIT_DEPTH),
    ]);
    const ov = ovr.list;
    const idx = new Map(eff.map((r) => [(r.scope?.user_id || sub) + '|' + r.period, r]));
    const actor = eff.find((r) => r.actor && (r.actor.email_address || r.actor.name))?.actor || null;
    const own = limits.filter((l) => l.scope.type === 'user' && l.scope.user_id === sub);
    const email = actor?.email_address || roster.get(sub) || null;
    if (!actor && !own.length && !roster.has(sub) && !d.models.length && !d.recent.length && !ov.length) throw new HttpError(404, 'unknown user');
    const budgets = budgetsFor(sub, idx);
    const catalog = cfg.catalog;
    const user = { sub, email, name: nameOf(sub, email, actor), budgets, ownLimits: Object.fromEntries(own.map((l) => [l.period, { id: l.id, amountCents: cents(l.amount) }])) };
    return {
      demo: cfg.demo, usage: info, range: w.range, data: w.data, buckets: iso(w), bucketSeconds: w.b,
      orgDefaults: Object.fromEntries(limits.filter((l) => l.scope.type === 'organization').map((l) => [l.period, cents(l.amount)])),
      user, series: d.series, models: d.models, recent: d.recent,
      auditTruncated: events.length >= AUDIT_DEPTH,
      audit: events.filter((e) => (e.after || e.before)?.scope?.user_id === sub).map((e) => describeEvent(e, new Map([[sub, email || sub]]))),
      overrides: ov, ...(ovr.error ? { overridesError: true } : {}),
      coach: buildCoach({ user, budgets, detail: d, range: w.range, catalog, overrides: ov, now: now() }),
    };
  }

  async function company(q) {
    const w = win(q);
    const [c, limits, lo, info] = await Promise.all([usage.company(w), gateway.listLimits(), liveOverrides(), usageInfo()]);
    const userLimits = limits.filter((l) => l.scope.type === 'user');
    const eff = await effectiveFor([...c.byUser.map((u) => u.sub), ...userLimits.map((l) => l.scope.user_id)]);
    const byUser = c.byUser.map((u) => ({ sub: u.sub, email: u.email || eff.actors.get(u.sub)?.email_address || null, requests: u.requests }));
    const seen = new Set(byUser.map((u) => u.sub));
    for (const sub of eff.subs) if (!seen.has(sub)) byUser.push({ sub, email: eff.actors.get(sub)?.email_address || null, requests: 0 });
    const spend = {};
    for (const p of PERIODS) {
      let s = 0, committed = 0, uncapped = 0;
      for (const u of byUser) { const b = budgetsFor(u.sub, eff.idx)[p]; s += b.spendCents; if (b.capCents === null) uncapped++; else committed += b.capCents; }
      spend[p] = { spendCents: s, committedCents: committed, uncappedUsers: uncapped };
    }
    const series = {};
    for (const u of byUser) series[u.sub] = c.series[u.sub] || zeros(w.n);
    return {
      demo: cfg.demo, usage: info, range: w.range, data: w.data, buckets: iso(w), totals: c.totals,
      org: Object.fromEntries(limits.filter((l) => l.scope.type === 'organization').map((l) => [l.period, { id: l.id, amountCents: cents(l.amount) }])),
      userOverrides: new Set(userLimits.map((l) => l.scope.user_id)).size, seats: byUser.length, spend, users: byUser, series, models: c.byModel,
      usersWithOverrides: new Set(userLimits.map((l) => l.scope.user_id)).size,
      overrides: { active: lo.list.filter((o) => o.status === 'active').length, scheduled: lo.list.filter((o) => o.status === 'scheduled').length, overdue: lo.list.filter((o) => o.overdue).length },
      ...(lo.error ? { overridesError: true } : {}),
    };
  }

  async function modelsList(q) {
    const w = win(q);
    const c = await usage.company(w);
    return { demo: cfg.demo, default: cfg.catalog.default, models: cfg.catalog.models, usage: c.byModel.map((m) => ({ model: m.model, requests: m.requests, ok: m.ok })) };
  }

  async function auditList(q) {
    const raw = Number(q.get('limit'));
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 100;
    const [events, roster, eff] = await Promise.all([gateway.audit(limit), usage.roster(), gateway.effectiveAll().catch(() => [])]);
    const names = new Map(roster);
    for (const r of eff) { const a = r.actor; if (r.scope?.user_id && (a?.email_address || a?.name)) names.set(r.scope.user_id, a.email_address || a.name); }
    return { demo: cfg.demo, events: events.map((e) => describeEvent(e, names)) };
  }

  async function applyBudget(scope, body, allowUnlimited, admin) {
    const p = parseBudgetBody(body, allowUnlimited);
    if (scope.type === 'user' && !(await knownUser(scope.user_id))) throw new HttpError(404, 'unknown user');
    const who = { key: admin.writeKey, actor: admin.email };
    const target = (l) => l.period === body.period && l.scope.type === scope.type && (l.scope.user_id || '') === (scope.user_id || '');
    let out;
    if (p.action === 'inherit') {
      const mine = (await gateway.listLimits()).find(target);
      if (mine) await gateway.remove(mine.id, who);
      out = { ok: true, removed: !!mine };
    } else {
      out = { ok: true, limit: await gateway.upsert(scope, body.period, p.action === 'unlimited' ? null : p.cents, who) };
    }
    log({ evt: 'budget.change', by: admin.email, scope, period: body.period, action: p.action, cents: p.cents ?? null });
    if (scope.type === 'user') await overrides.reconcile(scope.user_id).catch((e) => log({ evt: 'override.error', phase: 'reconcile', error: String(e?.message || e).slice(0, 200) }));
    return out;
  }

  async function knownUser(sub) {
    const [limits, roster] = await Promise.all([gateway.listLimits(), usage.roster()]);
    if (roster.has(sub) || limits.some((l) => l.scope.type === 'user' && l.scope.user_id === sub)) return true;
    // The real gateway answers for ids it has never seen with a row that has no actor: only a named actor counts as known.
    return (await gateway.effective([sub])).some((r) => r.scope?.user_id === sub && (r.actor?.email_address || r.actor?.name));
  }

  // ---------- ticking ----------
  // Overrides and usage ingest each have their own single-flight, so a slow ingest can never delay a revert.
  const flight = (fn) => { let p = null; return () => (p ||= fn().finally(() => { p = null; })); };
  const runOverrides = flight(() => overrides.tick());
  const runIngest = flight(async () => {
    try { return await usage.ingest(); } catch (e) { log({ evt: 'usage.ingest.error', error: String(e?.message || e).slice(0, 200) }); return { ingested: 0, error: 'ingest failed' }; }
  });
  let ticking = false, lastLazy = -Infinity;
  const tick = async () => {
    ticking = true;
    try {
      const [o, u] = await Promise.allSettled([runOverrides(), runIngest()]);
      invalidate();                                  // caps may have changed and new usage may have landed
      if (o.status === 'rejected') throw o.reason;   // an override failure fails the tick; an ingest failure is only reported in `usage`
      return { overrides: o.value, usage: u.value };
    } finally { ticking = false; }
  };
  const lazyTick = () => {
    if (!lazyMs || ticking || now() - lastLazy < lazyMs) return;
    lastLazy = now();
    tick().catch((e) => log({ evt: 'tick.error', error: String(e?.message || e).slice(0, 200) }));
  };
  const timer = timerMs > 0 && !cfg.inCloud ? setInterval(() => tick().catch((e) => log({ evt: 'tick.error', error: String(e?.message || e).slice(0, 200) })), timerMs) : null;
  timer?.unref();

  // ---------- routing ----------
  // Strict Host parsing: hostname (or [ipv6]) plus an optional numeric port. No userinfo, no trailing dot, no path, no spaces.
  // Note: the `.run.app` suffix admits every customer's run.app host, so on its own it is not a DNS-rebinding defence there.
  const suffixes = cfg.allowedHostSuffixes.map((x) => (x.startsWith('.') ? x : '.' + x).toLowerCase());
  const hostOk = (hostHeader) => {
    const m = HOST_RE.exec(String(hostHeader || ''));
    if (!m) return false;
    if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false;
    if (m[1] !== undefined) return m[1] === '::1';
    const host = m[2].toLowerCase();
    return cfg.allowedHosts.has(host) || suffixes.some((x) => host.endsWith(x) && host.length > x.length);
  };
  const clientIp = (req) => {
    if (cfg.inCloud) { const last = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (net.isIP(last)) return last; }   // the hop Google's frontend appended
    return req.socket?.remoteAddress || 'unknown';
  };
  const originOk = (origin, hostHeader) => cfg.devOrigins.has(origin) || cfg.allowedOrigins.has(origin) || origin === `http://${hostHeader}` || origin === `https://${hostHeader}`;

  async function route(req, res, url, cors) {
    const r = url.pathname, q = url.searchParams, method = req.method;
    const reply = (status, obj) => send(res, status, obj, { ...API_HEADERS, ...cors });
    const needView = () => { if (cfg.viewAccess === 'admin') auth.requireAdmin(req); };
    let m;

    if (r === '/api/health' && method === 'GET') {
      const [g, info] = await Promise.all([gatewayUp(), usageInfo()]);
      const a = auth.optionalAdmin(req);
      return reply(200, { gateway: g, usage: info, demo: cfg.demo, accounts: auth.accounts, viewAccess: cfg.viewAccess, maxOverrideDays: cfg.maxOverrideDays, admin: a ? { email: a.email, name: a.name } : null });
    }
    if (r === '/api/login' && method === 'POST') {
      let out;
      try { out = auth.login(await readJson(req), { ip: clientIp(req) }); } catch (e) { if (e?.delayMs) await sleep(e.delayMs); throw e; }
      if (out.delayMs) await sleep(out.delayMs);       // an account under a guessing campaign is answered slowly, never refused
      const { delayMs, ...body } = out;
      return reply(200, body);
    }
    if (r === '/api/logout' && method === 'POST') return reply(200, auth.logout(req));

    if (r === '/api/internal/tick' && method === 'POST') {
      const who = await auth.requireScheduler(req);
      const out = await tick();
      log({ evt: 'tick', via: who.via, applied: out.overrides.applied, ended: out.overrides.ended, failed: out.overrides.failed });
      return reply(200, out);
    }

    // Only the parameters the endpoints understand go into the cache key, so a random `?x=` cannot bypass the cache.
    const authed = !!auth.optionalAdmin(req);
    const ckey = () => `${r}?${['range', 'data', 'status', 'limit'].map((k) => q.get(k)).join('|')}|${cfg.viewAccess}`;
    if (r === '/api/users' && method === 'GET') { needView(); return reply(200, await cached(ckey(), () => usersList(q), authed)); }
    if ((m = r.match(/^\/api\/users\/([^/]+)$/)) && method === 'GET') { needView(); const sub = safeDecode(m[1]);
      if (!SUB_RE.test(sub)) throw new HttpError(400, 'bad user id');        // cheap checks first
      if (!(await knownSubs(authed)).has(sub)) throw new HttpError(404, 'unknown user');   // a flood of made-up ids costs one cached lookup, not a detail build each
      return reply(200, await cached(ckey(), () => userDetail(sub, q), authed)); }
    if (r === '/api/company' && method === 'GET') { needView(); return reply(200, await cached(ckey(), () => company(q), authed)); }
    if (r === '/api/models' && method === 'GET') { needView(); return reply(200, await cached(ckey(), () => modelsList(q), authed)); }
    if (r === '/api/audit' && method === 'GET') { needView(); return reply(200, await cached(ckey(), () => auditList(q), authed)); }
    if (r === '/api/overrides' && method === 'GET') {
      needView();
      return reply(200, await cached(ckey(), async () => { const r = await guardedOverrides({ status: q.get('status') || undefined }); return { demo: cfg.demo, overrides: r.list, ...(r.error ? { overridesError: true } : {}) }; }, authed));
    }

    if ((m = r.match(/^\/api\/users\/([^/]+)\/budget$/)) && method === 'PUT') {
      const admin = auth.requireAdmin(req);
      const sub = safeDecode(m[1]);
      if (!SUB_RE.test(sub)) throw new HttpError(400, 'bad user id');
      const body = await readJson(req);
      return reply(200, await writing(() => applyBudget({ type: 'user', user_id: sub }, body, true, admin)));
    }
    if (r === '/api/org/budget' && method === 'PUT') {
      const admin = auth.requireAdmin(req);
      const body = await readJson(req);
      return reply(200, await writing(() => applyBudget({ type: 'organization' }, body, false, admin)));
    }
    if (r === '/api/overrides' && method === 'POST') {
      const admin = auth.requireAdmin(req);
      const body = await readJson(req);
      if (typeof body.sub === 'string' && SUB_RE.test(body.sub) && !(await knownUser(body.sub))) throw new HttpError(404, 'unknown user');
      const input = { ...body };
      if (input.extraUsd !== undefined) input.extraUsd = parseCents(input.extraUsd) / 100;
      if (typeof input.reason === 'string') input.reason = cleanReason(input.reason);
      return reply(201, await writing(() => overrides.create(input, admin)));
    }
    if ((m = r.match(/^\/api\/overrides\/([^/]+)$/)) && method === 'DELETE') {
      const admin = auth.requireAdmin(req);
      const id = safeDecode(m[1]);
      if (!OVERRIDE_ID_RE.test(id)) throw new HttpError(404, 'no such override');
      return reply(200, await writing(() => overrides.cancel(id, admin)));
    }
    if ((m = r.match(/^\/api\/overrides\/([^/]+)\/retry$/)) && method === 'POST') {
      const admin = auth.requireAdmin(req);
      const id = safeDecode(m[1]);
      if (!OVERRIDE_ID_RE.test(id)) throw new HttpError(404, 'no such override');
      return reply(200, await writing(() => overrides.retry(id, admin)));
    }
    throw new HttpError(404, 'not found');
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'bad path'); } };

  const server = http.createServer(async (req, res) => {
    let url, cors = {};
    try {
      // Only origin-form targets ('/path?query') are served: no absolute URLs, '//', '*', backslashes, whitespace or control characters.
      const target = req.url;
      if (typeof target !== 'string' || target.length > LONG_TARGET || target[0] !== '/' || target[1] === '/' || /[\\\s\u0000-\u001f\u007f]/.test(target)) return send(res, 400, { error: 'bad request' }, API_HEADERS);
      try { url = new URL(target, 'http://x'); } catch { return send(res, 400, { error: 'bad request' }, API_HEADERS); }
      if (!hostOk(req.headers.host)) return send(res, 400, { error: 'bad host' }, API_HEADERS);   // DNS-rebinding guard
      const origin = req.headers.origin;
      if (origin && cfg.devOrigins.has(origin)) {
        cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, x-app-token, content-type',
          'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS', vary: 'origin' };
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...API_HEADERS, ...cors }); return res.end(); }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, { ...API_HEADERS, allow: 'GET, HEAD' });
        let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad path' }, API_HEADERS); }
        if (p.includes('\0') || p.split('/').includes('..')) return send(res, 400, { error: 'bad path' }, API_HEADERS);
        return serveStatic(cfg.dist, res, p);
      }
      if (origin && !originOk(origin, req.headers.host)) throw new HttpError(403, 'cross-origin request refused');
      lazyTick();
      await route(req, res, url, cors);
    } catch (e) {
      let status = e instanceof HttpError ? e.status : 500, message = e instanceof HttpError ? e.message : 'internal error';
      let headers = e instanceof HttpError ? e.headers : null;
      if (e instanceof HttpError && e.upstream) {
        // Gateway text is shown only to a signed-in admin and only if short and plain; everyone else gets a generic message.
        const admin = (() => { try { return auth.optionalAdmin(req); } catch { return null; } })();
        if (status >= 500) status = status === 503 || status === 504 ? status : 502;
        else if (!admin) status = 502;
        message = admin && SAFE_UPSTREAM.test(message) && !CREDENTIALISH.test(message) ? message : status >= 500 ? 'gateway unavailable' : 'gateway error';
        if (status >= 500) headers = { 'retry-after': '5', ...headers };
      }
      if (status === 500) log({ evt: 'error', path: url?.pathname, method: req.method, error: String(e?.message || e).slice(0, 300) });
      if (res.headersSent) return res.end();
      const extra = { ...API_HEADERS, ...cors, ...(headers || {}), ...(status === 413 ? { connection: 'close' } : {}) };
      send(res, status, { error: message }, extra);
      if (status === 413) res.once('finish', () => req.destroy());
    }
  });
  server.on('clientError', (err, socket) => {       // unparseable requests get the same JSON 400, and are not logged as errors
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: 24\r\n\r\n{"error":"bad request"}\n');
    else socket.destroy();
  });
  server.requestTimeout = 30e3; server.headersTimeout = 10e3; server.keepAliveTimeout = 5e3;

  return {
    server, tick, overrides, auth,
    close() {
      if (timer) clearInterval(timer);
      return new Promise((done) => {
        server.close(() => done());
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 3000).unref();
      });
    },
  };
}
