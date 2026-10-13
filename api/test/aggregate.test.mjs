import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store.mjs';
import { createAggregator, classify, latencyBin, medianOf } from '../lib/usage/aggregate.mjs';

const H = 3600, T0 = Math.floor(Date.UTC(2026, 9, 12, 10) / 1000 / H) * H;   // an hour boundary
const T0_H = T0;
const win = (data = 'all') => ({ range: '24h', data, n: 24, b: H, start: T0 - 20 * H, end: T0 + 4 * H });
const ev = (o) => ({ ts: (T0 + (o.dt ?? 60)) * 1000, requestId: o.id || Math.random().toString(36).slice(2), sub: 'u1', email: 'a@x.io', model: 'claude-sonnet-5-5', status: 200, ms: 120, upstream: 'vertex', loadTest: false, ...o });

test('classify: ok / spend_cap / upstream_error / rejected', () => {
  assert.equal(classify(200, 'vertex'), 'ok'); assert.equal(classify(429, ''), 'spend_cap');
  assert.equal(classify(429, 'vertex'), 'upstream_error'); assert.equal(classify(400, ''), 'rejected');
});

test('aggregates per user, model and outcome; recent keeps newest first', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({}), ev({ status: 200, ms: 300 }), ev({ model: 'claude-opus-5-5', status: 429, upstream: 'vertex', id: 'e1' }), ev({ sub: 'u2', email: 'b@x.io', status: 429, upstream: '', id: 'cap1' }), ev({ sub: 'u2', email: 'b@x.io', status: 400, upstream: '', model: '', loadTest: true })]);
  const u = await agg.users(win());
  const u1 = u.rows.find((r) => r.sub === 'u1'), u2 = u.rows.find((r) => r.sub === 'u2');
  assert.equal(u1.requests, 3); assert.equal(u1.ok, 2); assert.deepEqual(u1.models.sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(u2.requests, 2); assert.equal(u2.ok, 0);
  assert.equal(u.spark.get('u1').reduce((a, b) => a + b, 0), 3);
  const c = await agg.company(win());
  assert.deepEqual(c.totals, { requests: 5, ok: 2, upstream_errors: 1, blocked: 1, rejected: 1, users: 2 });
  assert.equal((await agg.company(win('real'))).totals.requests, 4, 'load-test traffic is excluded from "real"');
  assert.equal((await agg.company(win('loadtest'))).totals.requests, 1);
  const d = await agg.detail('u1', win());
  assert.equal(d.models[0].model, 'claude-sonnet-5-5'); assert.equal(d.models[0].requests, 2); assert.ok(d.models[0].p50 > 50 && d.models[0].p50 < 400);
  assert.equal(d.recent.length, 3);
});

test('upstream cause is attached whether the error line arrives before or after the event', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([], [{ requestId: 'early', cause: 'RESOURCE_EXHAUSTED' }]);              // error line first
  await agg.add([ev({ id: 'early', status: 429, upstream: 'vertex' })]);
  await agg.add([ev({ id: 'late', status: 403, upstream: 'vertex' })]);                   // event first
  await agg.add([], [{ requestId: 'late', cause: 'PERMISSION_DENIED' }]);
  const rec = (await agg.detail('u1', win())).recent;
  assert.equal(rec.find((r) => r.id === 'early').cause, 'RESOURCE_EXHAUSTED');
  assert.equal(rec.find((r) => r.id === 'late').cause, 'PERMISSION_DENIED');
});

test('rows outside the window are ignored; users with no activity still listed from the roster', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ dt: -30 * H })]);                                                    // 30h before T0: outside the 24h window
  const u = await agg.users(win());
  assert.equal(u.rows.length, 1); assert.equal(u.rows[0].requests, 0); assert.ok(u.rows[0].lastSeen);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Data-integrity regressions (adversarial review M2, M8, L3, L4, F8)
// ---------------------------------------------------------------------------------------------------------------------------------
test('L3: p50 of three 1000 ms requests reads ~1000 ms (not the 1131 ms bin mean), and missing/negative/zero latencies are ignored', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ id: 'a', ms: 1000 }), ev({ id: 'b', ms: 1000 }), ev({ id: 'c', ms: 1000 })]);
  const p = (await agg.detail('u1', win())).models[0].p50;
  assert.ok(Math.abs(p - 1000) <= 50, 'p50 ' + p);
  const a2 = createAggregator(createMemoryStore());
  await a2.add([ev({ id: 'a', ms: undefined }), ev({ id: 'b', ms: null }), ev({ id: 'c', ms: -3 }), ev({ id: 'd', ms: 0 }), ev({ id: 'e', ms: NaN }), ev({ id: 'f', ms: 4000 })]);
  const m = (await a2.detail('u1', win())).models[0];
  assert.equal(m.requests, 6); assert.equal(m.ok, 6); assert.ok(Math.abs(m.p50 - 4000) <= 200, 'only the one valid latency counts: ' + m.p50);
  const a3 = createAggregator(createMemoryStore()); await a3.add([ev({ ms: undefined })]);
  assert.equal((await a3.detail('u1', win())).models[0].p50, null, 'no valid latency at all -> unknown, not 0');
  const a4 = createAggregator(createMemoryStore());                                  // a spread: the median lands within one bin (~9%) of the truth
  await a4.add([100, 200, 300, 400, 500, 600, 700, 800, 900].map((ms, i) => ev({ id: 's' + i, ms })));
  assert.ok(Math.abs((await a4.detail('u1', win())).models[0].p50 - 500) <= 50);
});

test('M2: replaying events (same request ids) never double counts, in one call or across calls', async () => {
  const agg = createAggregator(createMemoryStore());
  const batch = [ev({ id: 'x1' }), ev({ id: 'x2', status: 429, upstream: 'vertex' })];
  await agg.add([...batch, ...batch]);                                               // duplicates inside one call
  await agg.add(batch, [{ requestId: 'x2', cause: 'RESOURCE_EXHAUSTED' }]); await agg.add(batch);
  assert.deepEqual((await agg.company(win())).totals, { requests: 2, ok: 1, upstream_errors: 1, blocked: 0, rejected: 0, users: 1 });
  const d = await agg.detail('u1', win()); assert.equal(d.recent.length, 2); assert.equal(d.recent.find((r) => r.id === 'x2').cause, 'RESOURCE_EXHAUSTED');
});

test('M2: the replay ledger is bounded by replayFloorMs (old hours are pruned) and `-Infinity` keeps everything', async () => {
  const hours = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ev({ id: 'h' + i, dt: i * 3600 }));
  const a = createAggregator(createMemoryStore()), s = createMemoryStore(); const b = createAggregator(s);
  await b.add(hours, [], { replayFloorMs: (T0 + 6 * 3600) * 1000 });
  const doc = await s.get('usage/agg/2026-10-12');
  assert.ok(Object.keys(doc.ids).length <= 2, 'only the hours a replay can still reach keep ids: ' + Object.keys(doc.ids));
  await a.add(hours, [], { replayFloorMs: -Infinity }); await a.add(hours, [], { replayFloorMs: -Infinity });
  assert.equal((await a.company({ ...win(), end: T0 + 12 * H })).totals.requests, 8);
});

test('L4: recent is ordered by the event timestamp, not by ingest order', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ id: 'newer', dt: 600 })]); await agg.add([ev({ id: 'older-late', dt: 60 })]); await agg.add([ev({ id: 'newest', dt: 1200 })]);
  assert.deepEqual((await agg.detail('u1', win())).recent.map((r) => r.id), ['newest', 'newer', 'older-late']);
});

test('L4: a quiet user keeps their own recent requests however busy everyone else is; the ring is per user (50) and the limit applies after the user filter', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ sub: 'quiet', email: 'q@x.io', id: 'q1', dt: -3 * 3600 })]);
  const busy = Array.from({ length: 2600 }, (_, i) => ev({ sub: 'busy', id: 'b' + i, dt: 60 + i }));
  for (let i = 0; i < busy.length; i += 500) await agg.add(busy.slice(i, i + 500));
  const q = await agg.detail('quiet', win()); assert.equal(q.recent.length, 1); assert.equal(q.recent[0].id, 'q1'); assert.equal(q.recent[0].email, 'q@x.io');
  const b = await agg.detail('busy', win(), 500);
  assert.equal(b.recent.length, 50, 'capped at 50 per user'); assert.equal(b.recent[0].id, 'b2599'); assert.equal((await agg.detail('busy', win())).recent.length, 25, 'default limit 25');
  assert.equal((await agg.detail('busy', win(), 3)).recent.length, 3);
});

test('M9/L4: recent is limited to the selected window and data filter', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ id: 'in', dt: 60 }), ev({ id: 'old', dt: -30 * 3600 }), ev({ id: 'lt', dt: 120, loadTest: true })]);
  assert.deepEqual((await agg.detail('u1', win())).recent.map((r) => r.id).sort(), ['in', 'lt']);
  assert.deepEqual((await agg.detail('u1', win('real'))).recent.map((r) => r.id), ['in']);
  assert.deepEqual((await agg.detail('u1', win('loadtest'))).recent.map((r) => r.id), ['lt']);
});

test('F8: subs named __proto__ / constructor / prototype are dropped (and counted), never pollute Object.prototype; odd-but-legal names like toString work', async () => {
  const agg = createAggregator(createMemoryStore());
  await agg.add([ev({ id: 'p1', sub: '__proto__' }), ev({ id: 'p2', sub: 'constructor' }), ev({ id: 'p3', sub: 'prototype' }), ev({ id: 'ok', sub: 'toString', email: 't@x.io' }), ev({ id: 'ok2', sub: 'hasOwnProperty' })]);
  assert.equal(({}).last, undefined); assert.equal(({}).first, undefined); assert.equal(Object.prototype.n, undefined);
  assert.deepEqual(agg.stats().droppedSubs, 3);
  const c = await agg.company(win());
  assert.equal(c.totals.requests, 2); assert.deepEqual(c.byUser.map((u) => u.sub).sort(), ['hasOwnProperty', 'toString']);
  assert.deepEqual(Object.keys(c.series).sort(), ['hasOwnProperty', 'toString']); assert.deepEqual(c.series.toString.reduce((a, b) => a + b, 0), 1);
  const u = await agg.users(win()); assert.deepEqual(u.rows.map((r) => r.sub).sort(), ['hasOwnProperty', 'toString']); assert.equal(u.spark.get('toString').reduce((a, b) => a + b, 0), 1);
  assert.equal((await agg.detail('toString', win())).models[0].requests, 1);
  assert.equal((await agg.detail('__proto__', win())).models.length, 0);
  assert.deepEqual([...(await agg.roster()).keys()].sort(), ['hasOwnProperty', 'toString']);
});

test('F8: distinct model names per day doc are capped: unknown models beyond the catalog bucket into "other"; strings are length-capped and cleaned', async () => {
  const known = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
  const store = createMemoryStore(), agg = createAggregator(store, { knownModels: known });
  const evil = Array.from({ length: 200 }, (_, i) => ev({ id: 'm' + i, model: 'attacker-' + i + 'x'.repeat(300) }));
  await agg.add([ev({ id: 'k1', model: 'claude-opus-5-5' }), ...evil, ev({ id: 'k2', model: 'claude-sonnet-5-5' })]);
  const doc = await store.get('usage/agg/2026-10-12');
  assert.ok(doc.m.length <= 11, 'model table stays small: ' + doc.m.length); assert.ok(doc.m.includes('other')); assert.ok(doc.m.every((m) => m.length <= 100));
  const byModel = (await agg.company(win())).byModel; assert.equal(byModel.find((m) => m.model === 'claude-sonnet-5-5').requests, 1, 'known models are always tracked by name');
  assert.equal(byModel.reduce((a, m) => a + m.requests, 0), 202); assert.ok(agg.stats().modelsBucketedToOther >= 190);
  const noCatalog = createAggregator(createMemoryStore()); await noCatalog.add(Array.from({ length: 300 }, (_, i) => ev({ id: 'n' + i, model: 'm' + i })));
  assert.ok((await noCatalog.company(win())).byModel.length <= 41, 'a cap applies even without a catalog');
  const long = createAggregator(createMemoryStore()); const bidi = String.fromCharCode(0x202e);
  await long.add([ev({ id: 'l', email: 'a'.repeat(1000) + '@x.io', model: 'bad' + bidi + 'name\n', sub: 's'.repeat(500) })]);
  const r = (await long.detail('s'.repeat(200), win())).recent[0]; assert.equal(r.model, 'badname'); assert.equal(r.email.length, 320);
});

test('M8: the day doc is compact (about 20-30 bytes per user-hour-model, not ~195) and legacy {rows} docs are read and upgraded', async () => {
  const store = createMemoryStore(), agg = createAggregator(store);
  const events = []; for (let u = 0; u < 200; u++) for (let h = 0; h < 6; h++) for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5']) for (let k = 0; k < 3; k++) events.push(ev({ id: `c${u}-${h}-${m}-${k}`, sub: 'u' + u, model: m, dt: h * 3600 + k, ms: 700 + k * 250 }));
  for (let i = 0; i < events.length; i += 500) await agg.add(events.slice(i, i + 500), [], { replayFloorMs: events[i].ts - 120e3 });
  const bytes = JSON.stringify(await store.get('usage/agg/2026-10-12')).length, rows = 200 * 6 * 2;
  assert.ok(bytes / rows < 45, `${(bytes / rows).toFixed(1)} bytes per row (ledger of the last hours included)`);
  assert.equal((await agg.company({ ...win(), end: T0 + 12 * H })).totals.requests, events.length);

  const legacy = createMemoryStore(), la = createAggregator(legacy);
  await legacy.put('usage/agg/2026-10-12', { rows: { k: { h: T0_H, sub: 'old', email: 'o@x.io', model: 'claude-sonnet-5-5', outcome: 'ok', lt: false, n: 4, msSum: 0, hist: [0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0] }, k2: { h: T0_H, sub: 'old', email: 'o@x.io', model: '', outcome: 'rejected', lt: false, n: 1, msSum: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } });
  assert.deepEqual((await la.company(win())).totals, { requests: 5, ok: 4, upstream_errors: 0, blocked: 0, rejected: 1, users: 1 });
  const p50 = (await la.detail('old', win())).models.find((m) => m.model === 'claude-sonnet-5-5').p50; assert.ok(p50 > 400 && p50 < 800, 'legacy bin 400-800: ' + p50);
  await la.add([ev({ id: 'new', sub: 'old' })]);                                          // the next write upgrades the doc in place
  assert.equal((await legacy.get('usage/agg/2026-10-12')).v, 2);
  assert.equal((await la.company(win())).totals.requests, 6);
});

test('L3 (round 2): the median of an even count is the mean of the two middle values; worst error vs the exact median stays under 8% on random lognormal data', async () => {
  const a = createAggregator(createMemoryStore());
  await a.add([ev({ id: 'e1', ms: 100 }), ev({ id: 'e2', ms: 1000 })]);
  const p = (await a.detail('u1', win())).models[0].p50; assert.ok(Math.abs(p - 550) <= 40, 'mean of ~100 and ~1000, not either one: ' + p);
  let s = 12345; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  let worst = 0;
  for (let trial = 0; trial < 3000; trial++) {
    const n = 1 + Math.floor(rnd() * (rnd() < 0.5 ? 12 : 400)), mu = Math.log(300 + rnd() * 5000), sigma = 0.1 + rnd() * 1.2;
    const xs = Array.from({ length: n }, () => Math.round(Math.min(100000, Math.max(1, Math.exp(mu + sigma * normal())))));
    const h = new Map(); for (const x of xs) { const b = latencyBin(x); h.set(b, (h.get(b) || 0) + 1); }
    const sorted = [...xs].sort((x, y) => x - y), exact = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    worst = Math.max(worst, Math.abs(medianOf(h) - exact) / exact);
  }
  assert.ok(worst < 0.08, 'worst relative error ' + worst);
});
