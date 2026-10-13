// Randomised, seeded checks of the data-integrity guarantees (adversarial review H1/H2/M2/L10/M5):
//  - overrides: create/tick/cancel/retry/hand-edit/org-change/failure-injection interleaved at random must never leave a boosted cap behind
//  - usage ingest: a failure at ANY store call, followed by a replay of the same events, never double counts
// A failing seed is printed; re-run it by setting INTEGRITY_SEEDS=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOverrides } from '../lib/overrides.mjs';
import { createFileStore, createMemoryStore, StoreError } from '../lib/store.mjs';
import { createAggregator } from '../lib/usage/aggregate.mjs';
import { ADMIN, H, fakeClock, memStore, personal, seededGateway, silent, testCfg } from './api-helpers.mjs';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const SEEDS = process.env.INTEGRITY_SEEDS ? process.env.INTEGRITY_SEEDS.split(',').map(Number) : Array.from({ length: 60 }, (_, i) => i + 1);
const SUBS = ['u1', 'u2'], PERIODS = ['weekly', 'monthly'];
const SYS = { key: 'k', actor: 'bob@example.com' };

async function overridesScenario(seed, steps = 90) {
  const rnd = mulberry(seed), pick = (a) => a[Math.floor(rnd() * a.length)], int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const clock = fakeClock(), gw = await seededGateway(clock), store = memStore();
  // failure injection on the four gateway calls the overrides code makes: before the effect, or after it (a lost response)
  const chaos = { p: 0 };
  const wrap = (name) => { const real = gw[name].bind(gw); return async (...a) => {
    const r = rnd() < chaos.p ? (rnd() < 0.5 ? 'before' : 'after') : null;
    if (r === 'before') throw new Error('injected 503 before ' + name);
    const out = await real(...a);
    if (r === 'after') throw new Error('injected timeout after ' + name);
    return out; }; };
  const flaky = new Proxy(gw, { get: (t, k) => (['listLimits', 'effective', 'upsert', 'remove'].includes(k) ? wrap(k) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const cfg = testCfg();
  const o = createOverrides({ store, gateway: flaky, cfg, now: clock.now, log: silent });
  const oracle = new Map(SUBS.flatMap((s) => PERIODS.map((p) => [s + '|' + p, { kind: 'none' }])));   // what the personal cap must be once every boost is over
  const trace = [];
  const state = (sub, period) => { const l = personal(gw, sub, period); return !l ? { kind: 'none' } : l.amount === null ? { kind: 'unlimited' } : { kind: 'cap', cents: Number(l.amount) }; };
  const ends = new Map();                                                                          // last end per user+period, to make adjacent boosts likely

  async function check(where) {
    const items = await o.list();
    for (const x of items) {
      if (x.status === 'active' && clock.t > Date.parse(x.endsAt)) assert.equal(x.overdue, true, `${where}: ${x.id} is active past its end without the overdue marker`);
      if (x.status !== 'active') assert.equal(x.overdue, false);
    }
    for (const sub of SUBS) for (const period of PERIODS) {
      const mine = items.filter((x) => x.sub === sub && x.period === period);
      assert.ok(mine.filter((x) => x.status === 'active').length <= 1, `${where}: two boosts active at once for ${sub}/${period}`);
      const busy = mine.some((x) => x.status === 'active' || (x.status === 'scheduled' && x.targetCents !== null));
      if (!busy) assert.deepEqual(state(sub, period), oracle.get(sub + '|' + period), `${where}: ${sub}/${period} left changed with no boost holding it`);
    }
  }

  try {
    for (let i = 0; i < steps; i++) {
      const op = rnd();
      if (op < 0.28) {
        const sub = pick(SUBS), period = pick(PERIODS), key = sub + '|' + period;
        const adjacent = ends.has(key) && ends.get(key) > clock.t && rnd() < 0.6;
        const startMs = adjacent ? ends.get(key) - clock.t : int(0, 6) * H / 2, durMs = int(1, 30) * H;
        trace.push(`create ${key} start+${startMs / H}h dur ${durMs / H}h${adjacent ? ' (adjacent)' : ''}`);
        try {
          const made = await o.create({ sub, period, extraUsd: int(10, 50), startsAt: new Date(clock.t + startMs).toISOString(), endsAt: new Date(clock.t + startMs + durMs).toISOString(), reason: 'prop ' + seed }, ADMIN);
          ends.set(key, Date.parse(made.endsAt));
        } catch (e) { if (!(e.status || /injected/.test(e.message))) throw e; }
      } else if (op < 0.5) { const d = int(1, 24) * H / 2; trace.push(`advance ${d / H}h`); clock.advance(d); }
      else if (op < 0.72) { trace.push('tick'); await o.tick().catch((e) => assert.match(e.message, /injected/)); }
      else if (op < 0.78) {
        const live = (await o.list()).filter((x) => x.status === 'scheduled' || x.status === 'active');
        if (live.length) { const x = pick(live); trace.push('cancel ' + x.id); await o.cancel(x.id, ADMIN).catch((e) => { if (!(e.status || /injected/.test(e.message))) throw e; }); }
      } else if (op < 0.84) {
        const failed = (await o.list()).filter((x) => x.status === 'failed');
        if (failed.length) { const x = pick(failed); trace.push('retry ' + x.id); await o.retry(x.id, ADMIN).catch((e) => { if (!(e.status || /injected/.test(e.message))) throw e; }); }
      } else if (op < 0.92) {
        const sub = pick(SUBS), period = pick(PERIODS), key = sub + '|' + period, kind = pick(['none', 'unlimited', 'cap', 'cap']);
        trace.push(`hand edit ${key} -> ${kind}`);
        if (kind === 'none') { const l = personal(gw, sub, period); if (l) await gw.remove(l.id, SYS); oracle.set(key, { kind: 'none' }); }
        else if (kind === 'unlimited') { await gw.upsert({ type: 'user', user_id: sub }, period, null, SYS); oracle.set(key, { kind: 'unlimited' }); }
        else { const cents = int(60, 400) * 100 + 7; await gw.upsert({ type: 'user', user_id: sub }, period, cents, SYS); oracle.set(key, { kind: 'cap', cents }); }   // never equals a boost target (those are whole dollars)
        if (rnd() < 0.7) await o.reconcile(sub).catch((e) => assert.match(e.message, /injected/));
      } else if (op < 0.96) { const v = int(100, 400) * 100; trace.push('org weekly ' + v); await gw.upsert({ type: 'organization' }, 'weekly', v, SYS); }
      else { chaos.p = chaos.p ? 0 : 0.3; trace.push('chaos ' + chaos.p); }
      await check(`seed ${seed} step ${i} (${trace.at(-1)})`);
    }
    // the storm is over: with a healthy gateway everything must settle, however long that takes
    chaos.p = 0; trace.push('--- calm ---');
    for (let i = 0; i < 12; i++) { clock.advance(40 * H); await o.tick(); }
    const left = (await o.list()).filter((x) => x.status === 'scheduled' || x.status === 'active');
    assert.deepEqual(left.map((x) => x.id), [], 'nothing is left live once every window is over');
    for (const [key, want] of oracle) { const [sub, period] = key.split('|'); assert.deepEqual(state(sub, period), want, `final personal cap of ${key}`); }
    await check('final');
  } catch (e) { e.message = `${e.message}\n  seed=${seed}; last steps:\n    ${trace.slice(-14).join('\n    ')}`; throw e; }
}

test(`overrides: ${SEEDS.length} seeded random interleavings keep the invariant (cap after all boosts = cap before the first, nothing overdue unmarked)`, async () => {
  for (const seed of SEEDS) await overridesScenario(seed);
});

// Two workers sharing one store and gateway, with the wall clock jumping (forwards and BACKWARDS, by more than the lease) in the middle of
// store and gateway calls, workers crashing mid-call, and failures injected. The reviewer's fuzz seed 42779 (two boosts active at once after clock
// jumps inside a tick) is the model for this.
async function clockChaosScenario(seed, steps = 80) {
  const rnd = mulberry(seed * 7919), pick = (a) => a[Math.floor(rnd() * a.length)], int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const clock = fakeClock(), gw = await seededGateway(clock), storeBase = memStore(), cfg = testCfg();
  const chaos = { jump: 0, fail: 0 }, never = () => new Promise(() => {}), trace = [];
  const oracle = new Map(SUBS.flatMap((s) => PERIODS.map((p) => [s + '|' + p, { kind: 'none' }])));
  const state = (sub, period) => { const l = personal(gw, sub, period); return !l ? { kind: 'none' } : l.amount === null ? { kind: 'unlimited' } : { kind: 'cap', cents: Number(l.amount) }; };
  const jump = () => { if (rnd() < chaos.jump) { const d = pick([1, 1000, 30e3, 4 * 60e3, 6 * 60e3, 3600e3, 25 * 3600e3, -1000, -3 * 60e3, -3600e3, -2 * 86400e3]); clock.t += d; trace.push('clock ' + d); } };
  const twoActive = async () => {
    const doc = await storeBase.get('overrides', { items: [] }), cnt = {};
    for (const o of doc.items) if (o.status === 'active' || (o.status === 'scheduled' && o.prev && o.targetCents !== null && o.targetCents !== undefined)) {
      const k = o.sub + '|' + o.period; cnt[k] = (cnt[k] || 0) + 1;
      assert.ok(cnt[k] <= 1, `two boosts active/mid-activation for ${k}: ${doc.items.filter((x) => x.sub === o.sub && x.period === o.period).map((x) => x.id.slice(4, 8) + ':' + x.status).join(',')}`);
    }
  };
  const mkInst = () => {
    const inst = { dead: false };
    const gwx = {}; for (const n of ['listLimits', 'effective', 'upsert', 'remove']) gwx[n] = async (...a) => {
      if (inst.dead) return never(); jump();
      const f = rnd() < chaos.fail ? pick(['before', 'after', 'crash-before', 'crash-after']) : null;
      if (f === 'before') throw new Error('injected'); if (f === 'crash-before') { inst.dead = true; return never(); }
      const r = await gw[n](...a); if (n === 'upsert' || n === 'remove') await twoActive();
      if (f === 'after') throw new Error('injected'); if (f === 'crash-after') { inst.dead = true; return never(); }
      jump(); return r; };
    const st = { list: (...a) => storeBase.list(...a), put: (...a) => storeBase.put(...a),
      get: async (...a) => { if (inst.dead) return never(); jump(); return storeBase.get(...a); },
      update: async (...a) => { if (inst.dead) return never(); jump(); const f = rnd() < chaos.fail ? pick(['before', 'after', 'crash-after']) : null; if (f === 'before') throw new Error('injected'); const r = await storeBase.update(...a); await twoActive(); if (f === 'after') throw new Error('injected'); if (f === 'crash-after') { inst.dead = true; return never(); } jump(); return r; } };
    inst.o = createOverrides({ store: st, gateway: gwx, cfg, now: () => clock.t, log: silent });
    return inst;
  };
  let insts = [mkInst(), mkInst()];
  const live = () => insts.filter((i) => !i.dead);
  const bgs = []; const bg = (p) => bgs.push(p.catch(() => {}));
  const settle = async () => { await Promise.race([Promise.all(bgs.splice(0)), new Promise((r) => setTimeout(r, 25))]); for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  try {
    for (let i = 0; i < steps; i++) {
      if (i === 4) { chaos.jump = pick([0, 0.1, 0.3]); chaos.fail = pick([0, 0.05, 0.15]); }
      if (!live().length) insts.push(mkInst());
      const op = rnd(), inst = pick(live());
      if (op < 0.3) {
        const sub = pick(SUBS), period = pick(PERIODS), start = clock.t + pick([0, 0, 1000, 30 * 60e3, 3600e3]), end = start + pick([3600e3, 2 * 3600e3, 24 * 3600e3, 7 * 86400e3]);
        trace.push(`create ${sub}|${period}`); bg(inst.o.create({ sub, period, extraUsd: pick([1, 25, 50, 99.99]), startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), reason: 'chaos ' + seed }, ADMIN));
      } else if (op < 0.6) { trace.push('tick'); bg(inst.o.tick()); if (rnd() < 0.5) { const j = pick(live()); trace.push('tick(concurrent)'); bg(j.o.tick()); } }
      else if (op < 0.68) { const l = (await storeBase.get('overrides', { items: [] })).items.filter((x) => x.status === 'scheduled' || x.status === 'active'); if (l.length) bg(inst.o.cancel(pick(l).id, ADMIN)); }
      else if (op < 0.74) { const l = (await storeBase.get('overrides', { items: [] })).items.filter((x) => x.status === 'failed'); if (l.length) bg(inst.o.retry(pick(l).id, ADMIN)); }
      else if (op < 0.8) { const x = pick(live()); x.dead = true; trace.push('kill'); insts.push(mkInst()); }
      else if (op < 0.9) { const d = pick([1000, 6 * 60e3, 3600e3, 25 * 3600e3, -2 * 86400e3, -3 * 60e3]); clock.t += d; trace.push('clock ' + d); }
      else if (op < 0.95) {
        await settle();
        const sub = pick(SUBS), period = pick(PERIODS), key = sub + '|' + period, cents = int(60, 400) * 100 + 7;
        await gw.upsert({ type: 'user', user_id: sub }, period, cents, SYS); oracle.set(key, { kind: 'cap', cents }); trace.push('hand ' + key);
      } else { await gw.upsert({ type: 'organization' }, 'weekly', int(100, 400) * 100, SYS); trace.push('org'); }
      await settle(); await twoActive();
    }
    chaos.jump = 0; chaos.fail = 0; await settle();
    const q = mkInst(); const doc = await storeBase.get('overrides', { items: [] });
    clock.t = Math.max(clock.t, ...doc.items.map((x) => Date.parse(x.endsAt))) + 86400e3;
    for (let i = 0; i < 14; i++) { clock.t += 6 * 60e3; await q.o.tick(); }
    const left = (await q.o.list()).filter((x) => x.status === 'scheduled' || x.status === 'active');
    assert.deepEqual(left.map((x) => x.id + ':' + x.status), [], 'nothing live at quiescence');
    for (const [key, want] of oracle) { const [sub, period] = key.split('|'); assert.deepEqual(state(sub, period), want, `final personal cap of ${key}`); }
  } catch (e) { e.message = `${e.message}\n  seed=${seed}; last steps: ${trace.slice(-14).join(' | ')}`; throw e; }
}

test('overrides: two workers, wall-clock jumps inside calls (+/- more than the lease), crashes and failures: never two active, always converges', async () => {
  const seeds = process.env.INTEGRITY_SEEDS ? SEEDS : Array.from({ length: 40 }, (_, i) => i + 1);
  for (const seed of seeds) await clockChaosScenario(seed);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Store: only ENOENT is "missing"
// ---------------------------------------------------------------------------------------------------------------------------------
test('file store: a torn document throws, is quarantined as a copy, and is never silently replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  const s = createFileStore(dir);
  await s.put('overrides', { items: [{ id: 'ovr_1', status: 'active' }] });
  const f = path.join(dir, 'overrides.json'), good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, good.slice(0, 15));
  await assert.rejects(s.get('overrides', { items: [] }), (e) => e instanceof StoreError && /corrupt/.test(e.message) && e.status === 500 && /overrides\.json\.corrupt-/.test(e.quarantined));
  await assert.rejects(s.update('overrides', (d) => { d.items.push({}); return d; }, { items: [] }), StoreError);
  assert.equal(fs.readFileSync(f, 'utf8'), good.slice(0, 15), 'the damaged file is left exactly as it was');
  const copies = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(copies.length, 1, 'one quarantine copy, not one per failed read');
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), good.slice(0, 15));
  await assert.rejects(s.get('overrides'), StoreError);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length, 1);
  await s.put('overrides', { items: [] });                                  // an operator can still repair on purpose
  assert.deepEqual(await s.get('overrides'), { items: [] });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
});

test('file store: only ENOENT is missing; an unreadable path and an empty file are errors; list() ignores quarantine copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  const s = createFileStore(dir);
  assert.equal(await s.get('nope', 'fb'), 'fb');
  fs.mkdirSync(path.join(dir, 'isdir.json'));                                // reading a directory: EISDIR, not "missing"
  await assert.rejects(s.get('isdir'), (e) => e instanceof StoreError && /cannot be read/.test(e.message));
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  await assert.rejects(s.get('empty'), StoreError);
  await assert.rejects(s.get('empty'), StoreError);
  assert.ok(!(await s.list('')).some((n) => n.includes('corrupt')), 'quarantine copies are not documents');
});

test('file store: write fsyncs the file before the rename (and the directory after)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  const calls = []; const real = { fsync: fs.fsyncSync, rename: fs.renameSync };
  fs.fsyncSync = (fd) => { calls.push('fsync'); return real.fsync(fd); };
  fs.renameSync = (a, b) => { calls.push('rename'); return real.rename(a, b); };
  try { await createFileStore(dir).put('x', { a: 1 }); } finally { fs.fsyncSync = real.fsync; fs.renameSync = real.rename; }
  assert.deepEqual(calls.slice(0, 2), ['fsync', 'rename']); assert.ok(calls.length >= 3, 'directory fsync after the rename');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Usage ingest idempotency (M2): a failure at each store call, then a replay of the very same events
// ---------------------------------------------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const W = { range: '24h', data: 'all', n: 24, b: 3600, start: Math.floor(T0 / 1000 / 3600) * 3600 - 20 * 3600, end: Math.floor(T0 / 1000 / 3600) * 3600 + 4 * 3600 };
const mkEvents = () => [
  { ts: T0 + 1000, requestId: 'r1', sub: 'u1', email: 'a@x.io', model: 'claude-sonnet-5-5', status: 200, ms: 900, upstream: 'vertex', loadTest: false },
  { ts: T0 + 2000, requestId: 'r2', sub: 'u1', email: 'a@x.io', model: 'claude-sonnet-5-5', status: 429, ms: 100, upstream: 'vertex', loadTest: false },
  { ts: T0 + 3000, requestId: 'r3', sub: 'u2', email: 'b@x.io', model: 'claude-opus-5-5', status: 200, ms: 4000, upstream: 'vertex', loadTest: false },
  { ts: T0 + 26 * 3600e3, requestId: 'r4', sub: 'u2', email: 'b@x.io', model: 'claude-opus-5-5', status: 200, ms: 4100, upstream: 'vertex', loadTest: false },   // next day: a second day doc
];
const W2 = { ...W, end: W.end + 30 * 3600 };

test('usage ingest: failing at every store call (get/update/put, each doc) and replaying never double counts', async () => {
  const names = new Set();
  const spy = (store, hook) => new Proxy(store, { get: (t, k) => (['get', 'update', 'put'].includes(k) ? async (name, ...a) => { await hook(k, name); return t[k](name, ...a); } : t[k]) });
  // pass 0 counts the store calls of a clean ingest; then one run per call number, failing exactly that call (before and after taking effect)
  let total = 0;
  { const s = createMemoryStore(); const agg = createAggregator(spy(s, () => { total++; }), { now: () => T0 }); await agg.add(mkEvents(), [{ requestId: 'r2', cause: 'RESOURCE_EXHAUSTED' }]); }
  assert.ok(total >= 6, 'at least day docs + roster + causes + recent are touched: ' + total);
  for (const when of ['before', 'after']) for (let failAt = 1; failAt <= total; failAt++) {
    const s = createMemoryStore(); let n = 0;
    const failing = new Proxy(s, { get: (t, k) => (['get', 'update', 'put'].includes(k) ? async (name, ...a) => {
      n++; names.add(name.replace(/\d{4}-\d\d-\d\d/, 'DAY'));
      if (n === failAt) { if (when === 'before') throw new Error('injected'); await t[k](name, ...a); throw new Error('injected after'); }
      return t[k](name, ...a); } : t[k]) });
    const agg = createAggregator(failing, { now: () => T0 });
    try { await agg.add(mkEvents(), [{ requestId: 'r2', cause: 'RESOURCE_EXHAUSTED' }]); } catch { /* expected for this call number */ }
    await agg.add(mkEvents(), [{ requestId: 'r2', cause: 'RESOURCE_EXHAUSTED' }]);            // the retry: same events again
    await agg.add(mkEvents());                                                                  // and once more for good measure
    const c = await agg.company(W2), d1 = await agg.detail('u1', W2);
    assert.deepEqual(c.totals, { requests: 4, ok: 3, upstream_errors: 1, blocked: 0, rejected: 0, users: 2 }, `store call #${failAt} failing ${when}`);
    assert.equal(d1.recent.length, 2, `recent ring has no duplicates (#${failAt} ${when})`);
    assert.equal(d1.recent.find((r) => r.id === 'r2').cause, 'RESOURCE_EXHAUSTED');
    assert.equal(d1.models[0].requests, 2);
    assert.equal((await agg.users(W2)).rows.reduce((a, r) => a + r.requests, 0), 4);
  }
  assert.ok([...names].some((x) => x.startsWith('usage/agg/')) && [...names].some((x) => x.startsWith('usage/roster')) && [...names].some((x) => x.startsWith('usage/recent')));
});
