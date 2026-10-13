// Dev mock of the budget API (contract: docs/ARCHITECTURE.md). Serves app/dist too, so `expo export` + this = a working app.
//   node app/dev/mock-api.mjs                  -> http://127.0.0.1:19110
// Env: MOCK_PORT, MOCK_VIEW=admin (reads need a session), MOCK_DEMO=1 (demo banner), MOCK_USAGE=none (usage not connected),
//      MOCK_ACCOUNTS=1 (login needs an email), MOCK_EMPTY=1 (no users), MOCK_FAIL=1 (every read fails 500).
// Admin login: password "demo" (email admin@example.com when MOCK_ACCOUNTS=1).  No secrets here; this is fake data only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 19110);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const E = process.env;
const VIEW = E.MOCK_VIEW === 'admin' ? 'admin' : 'open';
const SOURCE = E.MOCK_USAGE === 'none' ? 'none' : 'demo';
const ACCOUNTS = E.MOCK_ACCOUNTS === '1';
const HOUR = 3600e3, DAY = 24 * HOUR;
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------- deterministic fake data ----------
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const MODELS = [
  { alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'default', description: 'Everyday coding. The baseline everyone starts on.', enabled: true, pricePerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null } },
  { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'upgrade', description: 'Hardest problems. Costs more and uses budget faster, so it is an explicit step up.', enabled: true, pricePerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null } },
  { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'fast', description: 'Fast and cheap for simple, high-volume tasks.', enabled: true, pricePerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null } },
];
if (E.MOCK_PRICES === '1') MODELS[0].pricePerMTok = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const PEOPLE = [
  { sub: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace', mix: [0.45, 0.5, 0.05], weekly: [5000, 4650], monthly: [20000, 15200], load: 1.4, fail: 0.04 },
  { sub: 'u-grace', email: 'grace@example.com', name: 'Grace Hopper', mix: [0.8, 0.1, 0.1], weekly: [5000, 5200], monthly: [20000, 12100], load: 1.0, fail: 0.12 },
  { sub: 'u-linus', email: 'linus@example.com', name: 'Linus Torvalds', mix: [0.9, 0.0, 0.1], weekly: [null, 2400, 'unlimited'], monthly: [null, 9000, 'unlimited'], load: 0.8, fail: 0.02 },
  { sub: 'u-margaret', email: 'margaret@example.com', name: 'Margaret Hamilton', mix: [0.7, 0.2, 0.1], weekly: [5000, 3100], monthly: [20000, 7600], load: 0.9, fail: 0.01 },
  { sub: 'u-alan', email: 'alan@example.com', name: 'Alan Turing', mix: [0.6, 0.3, 0.1], weekly: [5000, 800], monthly: [20000, 2100], load: 0.3, fail: 0.0 },
  { sub: 'u-barbara', email: 'barbara@example.com', name: 'Barbara Liskov', mix: [0.5, 0.0, 0.5], weekly: [5000, 3200], monthly: [20000, 10900], load: 0.6, fail: 0.07 },
];
const ORG = { weekly: 5000, monthly: 20000 };
const state = {
  people: E.MOCK_EMPTY === '1' ? [] : PEOPLE.map((p) => ({ ...p })),
  own: new Map(),        // `${sub}:${period}` -> { id, amountCents|null }
  overrides: [],
  audit: [],
  tokens: new Map(),     // token -> { email, name }
};
for (const p of state.people) {
  for (const per of ['weekly', 'monthly']) {
    const [cap, , kind] = p[per];
    if (kind === 'unlimited') state.own.set(`${p.sub}:${per}`, { id: `lim-${p.sub}-${per}`, amountCents: null });
    else if (cap !== null && cap !== ORG[per]) state.own.set(`${p.sub}:${per}`, { id: `lim-${p.sub}-${per}`, amountCents: cap });
  }
}
let auditId = 100;
const logAudit = (o) => state.audit.unshift({ id: ++auditId, at: iso(now()), actor: 'mock-admin', scopeType: 'user', hadBefore: true, ...o });
// a couple of historical audit events and overrides so the Activity page has content
logAudit({ kind: 'raised', sub: 'u-ada', who: 'Ada Lovelace', period: 'monthly', fromCents: 15000, toCents: 20000 }); state.audit[0].at = iso(now() - 3 * DAY);
logAudit({ kind: 'created', sub: 'u-barbara', who: 'Barbara Liskov', period: 'weekly', fromCents: null, toCents: 5000, hadBefore: false }); state.audit[0].at = iso(now() - 6 * DAY);
logAudit({ kind: 'unlimited', sub: 'u-linus', who: 'Linus Torvalds', period: 'weekly', fromCents: 5000, toCents: null }); state.audit[0].at = iso(now() - 9 * DAY);
logAudit({ kind: 'lowered', sub: null, who: 'Everyone (default)', period: 'monthly', fromCents: 30000, toCents: 20000, scopeType: 'organization' }); state.audit[0].at = iso(now() - 12 * DAY);
if (state.people.length) {
  const mkO = (sub, period, extraCents, startMs, endMs, reason, status, extra = {}) => {
    const p = state.people.find((x) => x.sub === sub); const base = p[period][0] ?? 5000;
    state.overrides.push({ id: 'ovr_' + crypto.randomBytes(4).toString('hex'), sub, email: p.email, name: p.name, period, extraCents, baseCents: base, targetCents: base + extraCents,
      startsAt: iso(startMs), endsAt: iso(endMs), reason, createdBy: 'admin@example.com', createdAt: iso(startMs - HOUR), status, prev: { kind: 'none' }, appliedAt: status === 'scheduled' ? null : iso(startMs), endedAt: ['ended', 'cancelled', 'superseded', 'failed'].includes(status) ? iso(endMs) : null, note: null, ...extra });
  };
  mkO('u-grace', 'weekly', 5000, now() - 2 * DAY, now() + 2 * DAY + 3 * HOUR, 'On-call: payments incident rotation', 'active');
  mkO('u-margaret', 'monthly', 10000, now() + 5 * DAY, now() + 12 * DAY, 'Launch: v3 release crunch', 'scheduled');
  mkO('u-ada', 'weekly', 2500, now() - 20 * DAY, now() - 17 * DAY, 'Incident: database failover', 'ended');
  mkO('u-alan', 'weekly', 5000, now() - 8 * DAY, now() - 5 * DAY, 'Launch week', 'cancelled', { endedAt: iso(now() - 7 * DAY) });
  mkO('u-barbara', 'monthly', 5000, now() - 14 * DAY, now() - 7 * DAY, 'On-call', 'superseded', { note: 'Personal cap was changed while this boost was active.' });
  mkO('u-ada', 'monthly', 5000, now() - 30 * DAY, now() - 23 * DAY, 'Incident', 'failed', { note: 'No cap to extend at activation.' });
}

const RANGES = { '24h': [24, 3600], '7d': [28, 6 * 3600], '30d': [30, 86400] };
const win = (q) => { const range = RANGES[q.get('range')] ? q.get('range') : '7d'; const [n, b] = RANGES[range]; const end = Math.ceil(now() / 1000 / b) * b; return { range, data: ['all', 'real', 'loadtest'].includes(q.get('data')) ? q.get('data') : 'all', n, b, start: end - n * b }; };
const buckets = (w) => Array.from({ length: w.n }, (_, i) => iso((w.start + i * w.b) * 1000));
const hashN = (s) => crypto.createHash('md5').update(String(s)).digest().readUInt32BE(0);
function series(p, w) {
  let s = hashN(p.sub + w.range); const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const values = { 'claude-sonnet-5-5': [], 'claude-opus-5-5': [], 'claude-haiku-5-5': [] };
  for (let i = 0; i < w.n; i++) {
    const hour = new Date((w.start + i * w.b) * 1000).getHours();
    const dayFactor = hour >= 8 && hour <= 19 ? 1 : 0.25;
    const total = Math.round(r() * 9 * p.load * dayFactor * (w.b / 21600) ** 0.8);
    MODELS.forEach((m, k) => values[m.id].push(Math.round(total * p.mix[k])));
  }
  return values;
}
function budgets(p) {
  const out = {};
  for (const per of ['weekly', 'monthly']) {
    const own = state.own.get(`${p.sub}:${per}`);
    const cap = own ? own.amountCents : ORG[per] ?? null;
    const unlimited = !!own && own.amountCents === null;
    const spend = p[per][1];
    out[per] = { capCents: cap, spendCents: spend, source: own ? 'user' : cap === null ? null : 'organization', limitId: own?.id ?? null, unlimited };
  }
  out.daily = { capCents: null, spendCents: Math.round(p.weekly[1] / 5), source: null, limitId: null, unlimited: false };
  if (p.sub === 'u-ada') out.daily = { capCents: 2500, spendCents: 1900, source: 'organization', limitId: 'lim-org-daily', unlimited: false };
  return out;
}
const liveFor = (sub) => state.overrides.filter((o) => o.sub === sub && (o.status === 'active' || o.status === 'scheduled'));
const lastSeen = (p) => iso(now() - Math.round(p.load * 20 * 60e3 + hashN(p.sub) % 7200e3));
const recentFor = (p, w) => {
  const causes = [null, null, null, null, null, null, 'RESOURCE_EXHAUSTED', null, 'OVERLOADED', null];
  return Array.from({ length: 25 }, (_, i) => {
    const bad = (hashN(p.sub + i) % 100) / 100 < p.fail;
    const capped = p.sub === 'u-grace' && i < 2;
    const outcome = capped ? 'spend_cap' : bad ? 'upstream_error' : (hashN(p.sub + 'r' + i) % 41 === 0 ? 'rejected' : 'ok');
    const mi = (hashN(p.sub + 'm' + i) % 100) / 100 < p.mix[0] ? 0 : (hashN(p.sub + 'o' + i) % 100) / 100 < p.mix[1] / (1 - p.mix[0] + 1e-9) ? 1 : 2;
    return { ts: iso(now() - (i * 11 + 3) * 60e3 - (hashN(p.sub + i) % 300) * 1000), id: `req_${p.sub.slice(2)}_${(1000 + i * 37).toString(36)}`, sub: p.sub, email: p.email, model: MODELS[mi].id,
      outcome, status: outcome === 'ok' ? 200 : outcome === 'spend_cap' ? 429 : outcome === 'rejected' ? 400 : 529, ms: outcome === 'ok' ? 600 + (hashN(p.sub + 'l' + i) % 5200) : 80 + (hashN(p.sub + 'l' + i) % 300),
      lt: false, cause: outcome === 'upstream_error' ? causes[6 + (i % 2) * 2] : outcome === 'spend_cap' ? 'SPEND_CAP_REACHED' : null };
  });
};
function coach(p, b, mixSeries, rec) {
  const ins = [];
  const total = Object.values(mixSeries).flat().reduce((a, c) => a + c, 0) || 1;
  const opus = mixSeries['claude-opus-5-5'].reduce((a, c) => a + c, 0) / total;
  const fails = rec.filter((r) => r.outcome === 'upstream_error').length;
  const m = b.monthly, wk = b.weekly;
  if (opus > 0.3) ins.push({ id: 'opus-heavy', severity: 'high', category: 'model', title: `${Math.round(opus * 100)}% of your requests use Opus`, description: 'Opus costs more per request and uses your budget faster. Sonnet handles most everyday coding well. Keep Opus for the hardest problems.', action: './claude-gateway-setup.sh model sonnet', impact: 'Can stretch your weekly budget noticeably' });
  if (wk.capCents && wk.spendCents / wk.capCents >= 0.85) ins.push({ id: 'weekly-pace', severity: 'high', category: 'budget', title: 'You are close to your weekly limit', description: `You have used ${Math.round(wk.spendCents / wk.capCents * 100)}% of this week's budget. Requests are blocked at 100% until the week resets or an admin raises the cap.`, action: null, impact: null });
  else if (m.capCents && m.spendCents / m.capCents >= 0.6) ins.push({ id: 'monthly-pace', severity: 'medium', category: 'budget', title: 'Monthly spend is ahead of pace', description: 'You have used more than 60% of the monthly budget. If this continues you may reach the limit before the month ends.', action: null, impact: null });
  if (fails >= 2) ins.push({ id: 'errors', severity: 'medium', category: 'reliability', title: `${fails} of your last 25 requests hit provider errors`, description: 'Provider errors are usually temporary capacity limits. Retrying after a short pause normally works; they do not count against your budget.', action: null, impact: null });
  if (p.mix[2] < 0.2 && p.mix[0] > 0.6) ins.push({ id: 'haiku', severity: 'info', category: 'model', title: 'Try Haiku for quick, simple tasks', description: 'For renames, boilerplate and short questions, Haiku is faster and uses far less budget.', action: '/model haiku', impact: null });
  ins.push({ id: 'telemetry', severity: 'info', category: 'telemetry', title: 'Token and cache coaching needs client telemetry', description: 'Insights about context size and cache hits need telemetry from the Claude Code client, which is not connected yet. The tips above use only the model mix, outcomes and budget pace.', action: null, impact: null });
  return { summary: `Based on your last ${rec.length} requests and this period's budget pace.`, insights: ins };
}
const userRow = (p, w) => {
  const s = series(p, w); const tot = Object.values(s).flat().reduce((a, c) => a + c, 0);
  const rec = recentFor(p, w); const failed = Math.round(tot * p.fail);
  return { sub: p.sub, email: p.email, name: p.name, requests: tot, ok: tot - failed, failed, lastSeen: lastSeen(p), models: MODELS.filter((m, k) => p.mix[k] > 0).map((m) => m.id),
    spark: Array.from({ length: w.n }, (_, i) => Object.values(s).reduce((a, v) => a + v[i], 0)), budgets: budgets(p), overrides: liveFor(p.sub), _s: s, _rec: rec };
};

// ---------- http ----------
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, no) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(Object.assign(new Error('bad json'), { status: 400 })); } }); });
const err = (status, message) => Object.assign(new Error(message), { status });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };

function tick() {
  const t = now();
  for (const o of state.overrides) {
    if (o.status === 'scheduled' && new Date(o.startsAt) <= t) { o.status = 'active'; o.appliedAt = iso(t); }
    if (o.status === 'active' && new Date(o.endsAt) <= t) { o.status = 'ended'; o.endedAt = iso(t); }
  }
}
setInterval(tick, 5000);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const r = url.pathname, q = url.searchParams;
  if (!r.startsWith('/api/')) {
    let file = path.normalize(path.join(DIST, r === '/' ? 'index.html' : r));
    if (!file.startsWith(DIST)) { res.writeHead(400); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(503); return res.end('run: cd app && npx expo export -p web'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  try {
    tick();
    const sess = state.tokens.get(String(req.headers['x-app-token'] || '')) || null;
    if (req.headers.authorization) throw err(400, 'mock: the app must not send Authorization');
    if (r === '/api/health') return send(res, 200, { gateway: true, usage: { source: SOURCE, ok: SOURCE === 'none' ? null : true }, demo: E.MOCK_DEMO === '1', accounts: ACCOUNTS, viewAccess: VIEW, admin: sess });
    if (r === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (b.password !== 'demo' || (ACCOUNTS && String(b.email || '').toLowerCase() !== 'admin@example.com')) throw err(401, ACCOUNTS ? 'wrong email or password' : 'wrong password');
      const who = ACCOUNTS ? { email: 'admin@example.com', name: 'Dana Admin' } : { email: 'local-admin', name: 'Admin' };
      const token = crypto.randomBytes(16).toString('hex'); state.tokens.set(token, who);
      return send(res, 200, { token, ...who });
    }
    if (req.method === 'POST' && r === '/api/_mock/expire') { state.tokens.clear(); return send(res, 200, { ok: true }); }   // test helper: forces a 401 on the next write
    const isRead = req.method === 'GET';
    if (!isRead && !sess) throw err(401, 'sign in required');
    if (isRead && VIEW === 'admin' && !sess) throw err(401, 'sign in required');
    if (isRead && E.MOCK_FAIL === '1') throw err(500, 'internal error');
    let m;
    const w = win(q);
    if (r === '/api/users' && isRead) {
      const users = state.people.map((p) => { const { _s, _rec, ...u } = userRow(p, w); return u; });
      return send(res, 200, { range: w.range, data: w.data, demo: E.MOCK_DEMO === '1', usage: { source: SOURCE, ok: SOURCE === 'none' ? null : true }, buckets: buckets(w), users });
    }
    if ((m = r.match(/^\/api\/users\/([^/]+)$/)) && isRead) {
      const p = state.people.find((x) => x.sub === decodeURIComponent(m[1])); if (!p) throw err(404, 'unknown user');
      const u = userRow(p, w); const b = u.budgets;
      const models = MODELS.map((mm) => ({ model: mm.id, requests: u._s[mm.id].reduce((a, c) => a + c, 0), ok: Math.round(u._s[mm.id].reduce((a, c) => a + c, 0) * (1 - p.fail)), p50: 900 + (hashN(mm.id) % 800) })).filter((x) => x.requests > 0);
      const own = Object.fromEntries(['weekly', 'monthly'].filter((per) => state.own.has(`${p.sub}:${per}`)).map((per) => [per, state.own.get(`${p.sub}:${per}`)]));
      return send(res, 200, { demo: E.MOCK_DEMO === '1', usage: { source: SOURCE, ok: true }, range: w.range, data: w.data, buckets: buckets(w), bucketSeconds: w.b, orgDefaults: { daily: null, ...ORG },
        user: { sub: p.sub, email: p.email, name: p.name, budgets: b, ownLimits: own }, series: { models: Object.keys(u._s), values: u._s }, models, recent: u._rec,
        audit: state.audit.filter((e) => e.sub === p.sub), overrides: state.overrides.filter((o) => o.sub === p.sub).sort((a, c) => c.createdAt.localeCompare(a.createdAt)), coach: coach(p, b, u._s, u._rec) });
    }
    if ((m = r.match(/^\/api\/users\/([^/]+)\/budget$/)) && req.method === 'PUT') {
      const p = state.people.find((x) => x.sub === decodeURIComponent(m[1])); if (!p) throw err(404, 'unknown user');
      const b = await body(req); if (!['weekly', 'monthly'].includes(b.period)) throw err(400, 'period must be weekly or monthly');
      const key = `${p.sub}:${b.period}`; const before = budgets(p)[b.period].capCents;
      if (b.action === 'inherit') state.own.delete(key);
      else if (b.action === 'unlimited') state.own.set(key, { id: 'lim-' + key, amountCents: null });
      else if (b.action === 'set') { const usd = Number(b.usd); if (!(usd >= 0 && usd <= 100000)) throw err(400, 'amount must be between 0 and 100000'); state.own.set(key, { id: 'lim-' + key, amountCents: Math.round(usd * 100) }); }
      else throw err(400, 'action must be set, unlimited or inherit');
      const after = budgets(p)[b.period].capCents;
      logAudit({ kind: b.action === 'unlimited' ? 'unlimited' : after === null ? 'removed' : before === null || after > before ? 'raised' : after < before ? 'lowered' : 'unchanged', sub: p.sub, who: p.name, period: b.period, fromCents: before, toCents: after, actor: sess.email });
      return send(res, 200, { ok: true });
    }
    if (r === '/api/org/budget' && req.method === 'PUT') {
      const b = await body(req); if (!['weekly', 'monthly'].includes(b.period)) throw err(400, 'period must be weekly or monthly');
      const before = ORG[b.period] ?? null;
      if (b.action === 'inherit') delete ORG[b.period]; else if (b.action === 'set') ORG[b.period] = Math.round(Number(b.usd) * 100); else throw err(400, 'action must be set or inherit');
      logAudit({ kind: 'changed', scopeType: 'organization', sub: null, who: 'Everyone (default)', period: b.period, fromCents: before, toCents: ORG[b.period] ?? null, actor: sess.email });
      return send(res, 200, { ok: true });
    }
    if (r === '/api/company' && isRead) {
      const rows = state.people.map((p) => userRow(p, w));
      const sum = (f) => rows.reduce((a, u) => a + f(u), 0);
      const total = sum((u) => u.requests), ok = sum((u) => u.ok);
      const spend = {};
      for (const per of ['weekly', 'monthly']) spend[per] = { spendCents: sum((u) => u.budgets[per].spendCents), committedCents: sum((u) => u.budgets[per].capCents ?? 0), uncappedUsers: rows.filter((u) => u.budgets[per].capCents === null).length };
      const mdl = MODELS.map((mm) => ({ model: mm.id, requests: sum((u) => u._s[mm.id].reduce((a, c) => a + c, 0)) }));
      return send(res, 200, { demo: E.MOCK_DEMO === '1', usage: { source: SOURCE, ok: true }, range: w.range, data: w.data, buckets: buckets(w),
        totals: { requests: total, ok, upstream_errors: Math.round((total - ok) * 0.8), blocked: Math.round((total - ok) * 0.1), rejected: (total - ok) - Math.round((total - ok) * 0.8) - Math.round((total - ok) * 0.1), users: rows.length },
        org: Object.fromEntries(Object.entries(ORG).map(([k, v]) => [k, { id: 'lim-org-' + k, amountCents: v }])), userOverrides: state.own.size, seats: rows.length, spend,
        users: rows.map((u) => ({ sub: u.sub, email: u.email, requests: u.requests })), series: Object.fromEntries(rows.map((u) => [u.sub, u.spark])),
        models: mdl.map((x) => ({ ...x, ok: Math.round(x.requests * 0.95) })), overrides: { active: state.overrides.filter((o) => o.status === 'active').length, scheduled: state.overrides.filter((o) => o.status === 'scheduled').length } });
    }
    if (r === '/api/models' && isRead) {
      const rows = state.people.map((p) => userRow(p, w));
      const usage = MODELS.map((mm) => { const n = rows.reduce((a, u) => a + u._s[mm.id].reduce((x, c) => x + c, 0), 0); return { model: mm.id, requests: n, ok: Math.round(n * 0.95) }; });
      return send(res, 200, { default: 'sonnet', models: MODELS, usage: SOURCE === 'none' ? [] : usage });
    }
    if (r === '/api/audit' && isRead) return send(res, 200, { events: state.audit });
    if (r === '/api/overrides' && isRead) {
      const want = q.get('status') ? q.get('status').split(',') : null;
      return send(res, 200, { overrides: state.overrides.filter((o) => !want || want.includes(o.status)).sort((a, c) => c.createdAt.localeCompare(a.createdAt)) });
    }
    if (r === '/api/overrides' && req.method === 'POST') {
      const b = await body(req); const p = state.people.find((x) => x.sub === b.sub); if (!p) throw err(404, 'unknown user');
      if (!['weekly', 'monthly'].includes(b.period)) throw err(400, 'period must be weekly or monthly');
      const extra = Number(b.extraUsd); if (!(extra > 0 && extra <= 100000)) throw err(400, 'extraUsd must be greater than 0');
      const reason = String(b.reason || '').trim(); if (reason.length < 3 || reason.length > 200) throw err(400, 'reason must be 3 to 200 characters');
      const s = b.startsAt ? new Date(b.startsAt).getTime() : now(), e = new Date(b.endsAt).getTime();
      if (!Number.isFinite(e) || !Number.isFinite(s)) throw err(400, 'startsAt and endsAt must be ISO dates');
      if (e - s < HOUR) throw err(400, 'an override lasts at least 1 hour');
      if (e - s > 30 * DAY) throw err(400, 'an override can last at most 30 days');
      const clash = state.overrides.find((o) => o.sub === p.sub && o.period === b.period && (o.status === 'active' || o.status === 'scheduled') && new Date(o.startsAt) < e && new Date(o.endsAt) > s);
      if (clash) throw err(409, `${p.name} already has a ${clash.status} ${b.period} boost from ${clash.startsAt.slice(0, 10)} to ${clash.endsAt.slice(0, 10)}. Cancel it first or pick a different window.`);
      const cap = budgets(p)[b.period]; const base = cap.capCents ?? null;
      const o = { id: 'ovr_' + crypto.randomBytes(4).toString('hex'), sub: p.sub, email: p.email, name: p.name, period: b.period, extraCents: Math.round(extra * 100), baseCents: base, targetCents: base === null ? null : base + Math.round(extra * 100),
        startsAt: iso(s), endsAt: iso(e), reason, createdBy: sess.email, createdAt: iso(now()), status: s <= now() ? 'active' : 'scheduled', prev: { kind: 'none' }, appliedAt: s <= now() ? iso(now()) : null, endedAt: null, note: null };
      state.overrides.push(o);
      if (o.status === 'active' && base !== null) { const k = `${p.sub}:${b.period}`; const prev = state.own.get(k); o.prev = prev ? { kind: prev.amountCents === null ? 'unlimited' : 'cap', cents: prev.amountCents ?? undefined } : { kind: 'none' }; state.own.set(k, { id: 'lim-' + k, amountCents: o.targetCents }); }
      return send(res, 201, o);
    }
    if ((m = r.match(/^\/api\/overrides\/([^/]+)$/)) && req.method === 'DELETE') {
      const o = state.overrides.find((x) => x.id === m[1]); if (!o) throw err(404, 'unknown override');
      if (o.status !== 'active' && o.status !== 'scheduled') throw err(409, `this boost is already ${o.status}`);
      o.status = 'cancelled'; o.endedAt = iso(now());
      { const k = `${o.sub}:${o.period}`; const cur = state.own.get(k); if (cur && cur.amountCents === o.targetCents && o.appliedAt) { if (o.prev?.kind === 'cap') state.own.set(k, { id: cur.id, amountCents: o.prev.cents }); else if (o.prev?.kind === 'unlimited') state.own.set(k, { id: cur.id, amountCents: null }); else state.own.delete(k); } }
      return send(res, 200, o);
    }
    throw err(404, 'not found');
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`mock api + app on http://127.0.0.1:${PORT}  (view=${VIEW} usage=${SOURCE} demo=${E.MOCK_DEMO === '1'})`));
