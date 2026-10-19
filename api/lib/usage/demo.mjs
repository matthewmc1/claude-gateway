// Demo backend: deterministic synthetic traffic for the fictional DEMO_USERS, fed through the real aggregator so demo mode exercises the
// same code as production. It is only used when cfg.demo (APP_DEMO=1) and must never be presented as real data.
//
// Every request is a pure function of (seed, user, hour), so the same seed and `now` always give identical aggregates, and a later
// run on a persistent store only adds the hours that are missing.
import { DEMO_USERS } from '../demo-users.mjs';

const HOUR = 3600e3, DAY = 86400e3, DAYS = 30, BASE_PER_HOUR = 6, SEED = 'gateway-demo-v1';
// Typical end-to-end latency (median ms) per model alias, and per catalog tier for aliases we do not know.
const MEDIAN_MS = { haiku: 650, sonnet: 2300, opus: 4800 };
const TIER_MS = { fast: 650, default: 2300, upgrade: 4800 };
const WEEKDAY = [0.1, 1, 1, 1, 1, 1, 0.15];   // Sunday..Saturday: weekdays heavy, weekends light
const ERR_DAY = [0.3, 0.6, 1, 1, 1.5, 2.4];   // some days the provider is much worse than others (mean ~1.1)
const POLICY_REJECT = 0.0015, SPEND_CAP_P = 0.35, SPEND_CAP_WINDOW = 30 * HOUR;

function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function prng(seed) { let a = fnv(seed); return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function poisson(r, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(r)));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
// Relative intensity of an hour of the day for someone working [s, e) UTC: two peaks (late morning, afternoon), a lunch dip, a trickle after.
function shape(hr, [s, e]) {
  if (hr >= s && hr < e) { const x = (hr - s + 0.5) / (e - s); return (0.45 + 0.75 * Math.sin(Math.PI * x)) * (x > 0.42 && x < 0.58 ? 0.55 : 1); }
  return hr >= e && hr < e + 3 ? 0.06 : 0;
}

export async function create(cfg, { store, aggregator, now = () => Date.now(), seed = SEED } = {}) {
  const models = (cfg.catalog?.models || []).filter((m) => m.alias && m.id);
  const byAlias = new Map(models.map((m) => [m.alias, m]));
  // A profile says "sonnet"/"opus"/"haiku" (the family). Engineers get the entry that PINS that family (Sonnet 4.6 and Opus 5.5 as shipped, Opus 4.6 once an admin
  // runs the Opus 4.6 recipe), so the demo traffic follows the pin; a catalog without pin information falls back to the alias itself.
  const pinned = new Map(models.filter((m) => m.pinned === true && m.family).map((m) => [m.family, m]));
  const entryFor = (a) => pinned.get(a) || byAlias.get(a);
  const fallback = byAlias.get(cfg.catalog?.default) || models[0] || { alias: 'sonnet', id: 'claude-sonnet-5-5', tier: 'default' };
  const latencyOf = (m) => MEDIAN_MS[m.alias] ?? MEDIAN_MS[m.family] ?? TIER_MS[m.tier] ?? 2300;
  // Profile mix (by alias) -> [{ m, cum }] over the models this catalog actually has.
  const mixes = new Map(DEMO_USERS.map((u) => {
    const parts = Object.entries(u.profile.mix).filter(([a, p]) => p > 0 && entryFor(a)).map(([a, p]) => [entryFor(a), p]);
    const total = parts.reduce((s, [, p]) => s + p, 0) || 1; let acc = 0;
    return [u.sub, parts.length ? parts.map(([m, p]) => ({ m, cum: (acc += p / total) })) : [{ m: fallback, cum: 1 }]];
  }));
  const pick = (u, r) => { const x = r(); return (mixes.get(u.sub).find((p) => x <= p.cum) || mixes.get(u.sub).at(-1)).m; };

  function hourEvents(u, ui, hourIdx, tNow) {
    const hourStart = hourIdx * HOUR, day = new Date(hourStart), hr = day.getUTCHours();
    const intensity = shape(hr, u.profile.hours);
    if (!intensity) return [];
    const dr = prng(`${seed}|${u.sub}|d${Math.floor(hourStart / DAY)}`);
    const dayMult = Math.exp(0.25 * normal(dr)), errMult = ERR_DAY[Math.floor(dr() * ERR_DAY.length)];
    const r = prng(`${seed}|${u.sub}|h${hourIdx}`);
    const count = poisson(r, BASE_PER_HOUR * u.profile.weight * intensity * WEEKDAY[day.getUTCDay()] * dayMult);
    const out = [];
    for (let k = 0; k < count; k++) {
      const ts = hourStart + Math.floor(r() * HOUR), m = pick(u, r), roll = r(), kind = r(), lat = normal(r), extra = r();
      const e = { ts, requestId: `demo-${ui}-${hourIdx}-${k}`, sub: u.sub, email: u.email, model: m.id, status: 200, ms: 0, upstream: 'vertex', loadTest: false };
      if (roll < POLICY_REJECT) { Object.assign(e, { status: 400, model: '', upstream: '', ms: 8 + Math.floor(extra * 30) }); }   // the gateway refuses before the provider
      else if (u.budget.weeklyPct >= 1 && ts >= tNow - SPEND_CAP_WINDOW && extra < SPEND_CAP_P) { Object.assign(e, { status: 429, upstream: '', ms: 10 + Math.floor(kind * 50) }); }   // at the personal limit
      else if (roll < POLICY_REJECT + u.profile.errorRate * errMult) {
        const [status, cause] = kind < 0.72 ? [429, 'RESOURCE_EXHAUSTED'] : kind < 0.92 ? [403, 'PERMISSION_DENIED'] : [429, 'RESOURCE_EXHAUSTED'];
        Object.assign(e, { status, cause, ms: 150 + Math.floor(extra * 550) });
      } else e.ms = Math.min(90000, Math.max(80, Math.round(latencyOf(m) * Math.exp(0.55 * lat))));
      out.push(e);
    }
    return out;
  }

  // A few load-test bursts (a team checking capacity), attributed to one demo user and flagged so the "real" filter excludes them.
  function loadTests(tNow) {
    const u = DEMO_USERS.find((x) => x.sub === 'demo-ivo') || DEMO_USERS.at(-1), m = entryFor('sonnet') || fallback, r = prng(`${seed}|loadtest`), out = [];
    const today = Math.floor(tNow / DAY) * DAY;
    for (const back of [9, 4, 1]) for (let i = 0; i < 12; i++) {
      const throttled = i === 7, ms = 400 + Math.floor(r() * 500);
      out.push({ ts: today - back * DAY + 14 * HOUR + i * 40e3, requestId: `demo-lt-${back}-${i}`, sub: u.sub, email: u.email, model: m.id, status: throttled ? 429 : 200, ms: throttled ? 180 : ms, upstream: 'vertex', loadTest: true, ...(throttled ? { cause: 'RESOURCE_EXHAUSTED' } : {}) });
    }
    return out;
  }

  async function seedData() {
    const tNow = now(), marker = await store.get('usage/demo-seed', null);
    const after = marker?.through ?? (Math.floor(tNow / HOUR) * HOUR - DAYS * DAY);
    if (tNow <= after) return 0;
    const events = loadTests(tNow);
    for (let h = Math.floor(after / HOUR); h <= Math.floor(tNow / HOUR); h++) DEMO_USERS.forEach((u, ui) => events.push(...hourEvents(u, ui, h, tNow)));
    const fresh = events.filter((e) => e.ts > after && e.ts <= tNow).sort((a, b) => a.ts - b.ts || (a.requestId < b.requestId ? -1 : 1));
    const byDay = new Map();
    for (const e of fresh) { const d = Math.floor(e.ts / DAY); (byDay.get(d) || byDay.set(d, []).get(d)).push(e); }
    for (const d of [...byDay.keys()].sort((a, b) => a - b)) await aggregator.add(byDay.get(d), [], { replayFloorMs: -Infinity });   // keep every request id: a crash before the marker below re-feeds whole days   // oldest day first so "recent" ends newest-first
    await store.put('usage/demo-seed', { through: tNow, seed, version: 1 });
    return fresh.length;
  }
  await seedData();

  return {
    source: 'demo', async ok() { return true; }, async ingest() { return { ingested: 0 }; },
    roster: () => aggregator.roster(), users: (w) => aggregator.users(w), detail: (sub, w, limit) => aggregator.detail(sub, w, limit), company: (w) => aggregator.company(w),
  };
}
