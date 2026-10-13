import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverrides } from '../lib/overrides.mjs';
import { ADMIN, D, H, effAmount, fakeClock, isoAt, memStore, personal, seededGateway, silent, testCfg } from './api-helpers.mjs';

async function setup(patchCfg = {}) {
  const clock = fakeClock();
  const gw = await seededGateway(clock);
  const store = memStore();
  const cfg = testCfg({}, patchCfg);
  const o = createOverrides({ store, gateway: gw, cfg, now: clock.now, log: silent });
  const mk = (extra = {}) => ({ sub: 'u1', period: 'weekly', extraUsd: 50, startsAt: isoAt(clock, 2 * H), endsAt: isoAt(clock, 26 * H), reason: 'on-call week', ...extra });
  return { clock, gw, store, cfg, o, mk };
}
const auditCount = async (gw) => (await gw.audit(1000)).length;
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)), `expected ${status} ${re || ''}`);

test('lifecycle: scheduled -> active -> ended, restoring "no personal limit"', async () => {
  const { clock, gw, o, mk } = await setup();
  const made = await o.create(mk(), ADMIN);
  assert.equal(made.status, 'scheduled'); assert.equal(made.sub, 'u1'); assert.equal(made.email, 'u1@example.com');
  assert.equal(made.extraCents, 5000); assert.equal(made.baseCents, 15000); assert.equal(made.createdBy, 'ada@example.com');
  assert.match(made.id, /^ovr_[0-9a-f]{12}$/);
  assert.equal(made.claim, undefined, 'internals are not exposed');

  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 0 }, 'nothing due yet');
  assert.equal(personal(gw, 'u1', 'weekly'), null);

  clock.advance(3 * H);
  assert.deepEqual(await o.tick(), { applied: 1, ended: 0, failed: 0 });
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
  const live = (await o.list({ status: 'active' }))[0];
  assert.equal(live.status, 'active'); assert.deepEqual(live.prev, { kind: 'none' }); assert.equal(live.targetCents, 20000); assert.ok(live.appliedAt);
  assert.equal((await gw.audit(1))[0].actor, 'admin-key:system:overrides', 'automatic changes are attributed to the system actor');
  assert.equal(await effAmount(gw, 'u1', 'monthly'), '50000', 'other period untouched');

  const n = await auditCount(gw);
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 0 }, 'idempotent while active');
  assert.equal(await auditCount(gw), n);

  clock.advance(24 * H);
  assert.deepEqual(await o.tick(), { applied: 0, ended: 1, failed: 0 });
  assert.equal(personal(gw, 'u1', 'weekly'), null, 'personal limit deleted again');
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
  const done = (await o.forUser('u1'))[0];
  assert.equal(done.status, 'ended'); assert.ok(done.endedAt);
  const m = await auditCount(gw);
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 0 }, 'idempotent after ending');
  assert.equal(await auditCount(gw), m);
});

test('restores a previous personal cap', async () => {
  const { clock, gw, o, mk } = await setup();
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', 8000, { key: 'k', actor: 'ada@example.com' });
  const made = await o.create(mk({ extraUsd: 55.5 }), ADMIN);
  assert.equal(made.baseCents, 8000);
  clock.advance(3 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '13550');
  assert.deepEqual((await o.list())[0].prev, { kind: 'cap', cents: 8000 });
  clock.advance(24 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '8000');
  assert.equal(personal(gw, 'u1', 'weekly').amount, '8000');
});

test('restores a previous "unlimited" personal limit (state seeded directly, since the API refuses unlimited users)', async () => {
  const { clock, gw, store, o } = await setup();
  await gw.upsert({ type: 'user', user_id: 'u2' }, 'monthly', 99000, { key: 'k', actor: 'x' });
  const t = clock.t;
  await store.put('overrides', { items: [{
    id: 'ovr_aaaaaaaaaaaa', sub: 'u2', email: null, name: 'u2', period: 'monthly', extraCents: 1000, baseCents: 98000, targetCents: 99000,
    startsAt: new Date(t - 5 * H).toISOString(), endsAt: new Date(t - H).toISOString(), reason: 'seeded', createdBy: 'ada@example.com', createdAt: new Date(t - 6 * H).toISOString(),
    status: 'active', prev: { kind: 'unlimited' }, appliedAt: new Date(t - 5 * H).toISOString(), endedAt: null, note: null }] });
  assert.deepEqual(await o.tick(), { applied: 0, ended: 1, failed: 0 });
  assert.equal(personal(gw, 'u2', 'monthly').amount, null, 'back to unlimited');
  assert.equal((await o.list())[0].status, 'ended');
});

test('a manual edit during the boost wins: superseded, value left alone', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', 31000, { key: 'k', actor: 'bob@example.com' });
  clock.advance(24 * H);
  assert.deepEqual(await o.tick(), { applied: 0, ended: 1, failed: 0 });
  assert.equal(personal(gw, 'u1', 'weekly').amount, '31000');
  const x = (await o.list())[0];
  assert.equal(x.status, 'superseded'); assert.match(x.note, /changed by hand/);
});

test('removing the personal limit by hand during the boost also leaves things alone', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
  await gw.remove(personal(gw, 'u1', 'weekly').id, { key: 'k', actor: 'bob@example.com' });
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null);
  assert.ok(['superseded', 'ended'].includes((await o.list())[0].status));
});

test('reconcile() supersedes an active boost right after a manual edit', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
  assert.equal(await o.reconcile('u1'), 0, 'untouched boost stays active');
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', 1000, { key: 'k', actor: 'bob@example.com' });
  assert.equal(await o.reconcile('u1'), 1);
  assert.equal((await o.list())[0].status, 'superseded');
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '1000');
});

test('cancel: scheduled, active (reverts), and bad states', async () => {
  const { clock, gw, o, mk } = await setup();
  const a = await o.create(mk(), ADMIN);
  const c1 = await o.cancel(a.id, ADMIN);
  assert.equal(c1.status, 'cancelled'); clock.advance(3 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null, 'a cancelled boost never starts');
  await rejects(o.cancel(a.id, ADMIN), 409, /already cancelled/);
  await rejects(o.cancel('ovr_000000000000', ADMIN), 404);

  const b = await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 10 * H) }), ADMIN);
  clock.advance(2 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
  const c2 = await o.cancel(b.id, ADMIN);
  assert.equal(c2.status, 'cancelled'); assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
  assert.equal(personal(gw, 'u1', 'weekly'), null);
});

test('cancel of an active boost that was edited by hand leaves the new value', async () => {
  const { clock, gw, o, mk } = await setup();
  const a = await o.create(mk({ startsAt: isoAt(clock, H) }), ADMIN); clock.advance(2 * H); await o.tick();
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', 12345, { key: 'k', actor: 'bob@example.com' });
  const c = await o.cancel(a.id, ADMIN);
  assert.equal(c.status, 'cancelled'); assert.match(c.note, /by hand/);
  assert.equal(personal(gw, 'u1', 'weekly').amount, '12345');
});

test('overlap: 409 for the same user and period, fine otherwise', async () => {
  const { clock, o, mk } = await setup();
  const a = await o.create(mk(), ADMIN);
  await rejects(o.create(mk({ startsAt: isoAt(clock, 10 * H), endsAt: isoAt(clock, 40 * H) }), ADMIN), 409);
  await rejects(o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H) }), ADMIN), 409);
  await o.create(mk({ period: 'monthly' }), ADMIN);                                     // other period
  await o.create(mk({ sub: 'u2' }), ADMIN);                                              // other user
  await o.create(mk({ startsAt: isoAt(clock, 26 * H), endsAt: isoAt(clock, 50 * H) }), ADMIN);   // back to back is not an overlap
  await o.cancel(a.id, ADMIN);
  await o.create(mk({ startsAt: isoAt(clock, 10 * H), endsAt: isoAt(clock, 20 * H) }), ADMIN);   // cancelled ones free the slot
});

test('back-to-back boosts: the first reverts before the second reads the cap', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 5 * H), extraUsd: 10 }), ADMIN);
  await o.create(mk({ startsAt: isoAt(clock, 5 * H), endsAt: isoAt(clock, 9 * H), extraUsd: 20 }), ADMIN);
  clock.advance(2 * H); await o.tick(); assert.equal(await effAmount(gw, 'u1', 'weekly'), '16000');
  clock.advance(3 * H);                                   // exactly when the first ends and the second starts
  assert.deepEqual(await o.tick(), { applied: 1, ended: 1, failed: 0 });
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '17000', 'base 15000 + 20, not 16000 + 20');
  clock.advance(5 * H); await o.tick(); assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});

test('failed: the cap disappeared before start, or the whole window was missed', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN);
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', null, { key: 'k', actor: 'bob@example.com' });   // now unlimited
  const before = await auditCount(gw);
  clock.advance(3 * H);
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 1 });
  assert.equal(await auditCount(gw), before, 'gateway untouched');
  const f = (await o.list())[0]; assert.equal(f.status, 'failed'); assert.match(f.note, /unlimited/);

  const t = await setup();
  await t.o.create(t.mk(), ADMIN);
  t.clock.advance(30 * H);                                 // app was down for the whole window
  assert.deepEqual(await t.o.tick(), { applied: 0, ended: 0, failed: 1 });
  assert.equal(personal(t.gw, 'u1', 'weekly'), null);
  assert.match((await t.o.list())[0].note, /passed/);
});

test('validation matrix', async () => {
  const { clock, gw, o, mk } = await setup();
  const bad = async (patch, re) => rejects(o.create(mk(patch), ADMIN), 400, re);
  await bad({ sub: '' }, /user/); await bad({ sub: 'a b' }, /user/); await bad({ sub: 5 }, /user/);
  await bad({ period: 'daily' }, /period/); await bad({ period: undefined }, /period/);
  for (const v of [0, -5, NaN, Infinity, 100000.01, 1e9, null, true, '', 'abc', [], {}]) await bad({ extraUsd: v }, /extra amount/);
  await bad({ extraUsd: 0.001 }, /at least 0.01|more than 0/);
  await bad({ reason: 'ab' }, /reason/); await bad({ reason: '   ' }, /reason/); await bad({ reason: 'x'.repeat(201) }, /reason/); await bad({ reason: 42 }, /reason/);
  await bad({ endsAt: 'tomorrow-ish' }, /endsAt/); await bad({ endsAt: undefined }, /endsAt/); await bad({ startsAt: 'nope' }, /startsAt/); await bad({ startsAt: 12345 }, /startsAt/);
  await bad({ startsAt: isoAt(clock, -H), endsAt: isoAt(clock, H) }, /past/);
  await bad({ startsAt: isoAt(clock, 5 * H), endsAt: isoAt(clock, 4 * H) }, /after startsAt/);
  await bad({ startsAt: isoAt(clock, -D), endsAt: isoAt(clock, -H) }, /past|future/);
  await bad({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 1.5 * H) }, /at least 1 hour/);
  await bad({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 91 * D) }, /at most 90 days/);
  await bad({ startsAt: isoAt(clock, 400 * D), endsAt: isoAt(clock, 401 * D) }, /too far/);
  assert.equal((await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 2 * H) }), ADMIN)).status, 'scheduled', 'exactly 1 hour is fine');
  await rejects(o.create(null, ADMIN), 400);
  // no base cap to extend
  await gw.upsert({ type: 'user', user_id: 'u3' }, 'monthly', null, { key: 'k', actor: 'x' });
  await rejects(o.create(mk({ sub: 'u3', period: 'monthly' }), ADMIN), 400, /unlimited/);
  const bare = await seededGateway(clock);
  bare.limits.length = 0;
  const o2 = createOverrides({ store: memStore(), gateway: bare, cfg: testCfg(), now: clock.now, log: silent });
  await rejects(o2.create(mk(), ADMIN), 400, /no budget cap/);
  // maxOverrideDays is configurable
  const small = await setup({ maxOverrideDays: 2 });
  await rejects(small.o.create(small.mk({ endsAt: isoAt(small.clock, 3 * D) }), small.ADMIN || ADMIN), 400, /at most 2 days/);
});

test('create with no startsAt applies immediately', async () => {
  const { gw, o, mk } = await setup();
  const made = await o.create(mk({ startsAt: undefined }), ADMIN);
  assert.equal(made.status, 'active'); assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
});

test('two instances ticking at once apply the boost exactly once', async () => {
  const { clock, gw, store, cfg, o, mk } = await setup();
  const other = createOverrides({ store, gateway: gw, cfg, now: clock.now, log: silent });
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  const before = await auditCount(gw);
  const [a, b] = await Promise.all([o.tick(), other.tick()]);
  assert.equal(a.applied + b.applied, 1);
  assert.equal((await auditCount(gw)) - before, 1);
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000', 'not stacked');
  clock.advance(24 * H);
  const [c, d] = await Promise.all([o.tick(), other.tick(), o.tick()]);
  assert.equal(c.ended + d.ended, 1);
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});

test('crash recovery: gateway already updated but the store still says scheduled', async () => {
  const { clock, gw, store, o, mk } = await setup();
  const made = await o.create(mk(), ADMIN);
  clock.advance(3 * H);
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'weekly', 20000, { key: 'k', actor: 'system:overrides' });   // the part that completed
  await store.update('overrides', (d) => { Object.assign(d.items[0], { prev: { kind: 'none' }, baseCents: 15000, targetCents: 20000, claim: { id: 'dead', at: clock.t - 10 * 60e3, kind: 'start' } }); return d; });
  assert.deepEqual(await o.tick(), { applied: 1, ended: 0, failed: 0 });
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000', 'not stacked to 25000');
  assert.equal((await o.list())[0].status, 'active'); assert.equal(made.id, (await o.list())[0].id);
  clock.advance(24 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});

test('crash recovery: plan stored, gateway not yet changed, so the worker finishes the job', async () => {
  const { clock, gw, store, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  await store.update('overrides', (d) => { Object.assign(d.items[0], { prev: { kind: 'none' }, baseCents: 15000, targetCents: 20000, claim: { id: 'dead', at: clock.t - 10 * 60e3, kind: 'start' } }); return d; });
  await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
});

test('a fresh claim from another worker is respected, a stale one is taken over', async () => {
  const { clock, gw, store, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  await store.update('overrides', (d) => { d.items[0].claim = { id: 'other', at: clock.t - 30e3, kind: 'start' }; return d; });
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 0 });
  assert.equal(personal(gw, 'u1', 'weekly'), null);
  clock.advance(6 * 60e3);                                 // the lease is 5 minutes (L12: generous, to tolerate clock skew between instances)
  assert.deepEqual(await o.tick(), { applied: 1, ended: 0, failed: 0 });
});

test('gateway errors: start retries then succeeds; reverts keep retrying until they work', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  const realUpsert = gw.upsert; let fail = 2;
  gw.upsert = async (...a) => { if (fail-- > 0) throw new Error('gateway 503'); return realUpsert(...a); };
  assert.equal((await o.tick()).failed, 1); assert.equal((await o.list())[0].status, 'scheduled'); assert.match((await o.list())[0].note, /will retry/);
  assert.equal((await o.tick()).failed, 1);
  assert.deepEqual(await o.tick(), { applied: 1, ended: 0, failed: 0 });
  assert.equal((await o.list())[0].note, null);

  clock.advance(24 * H);
  const realRemove = gw.remove; let rf = 3;
  gw.remove = async (...a) => { if (rf-- > 0) throw new Error('gateway 500'); return realRemove(...a); };
  for (let i = 0; i < 3; i++) { assert.equal((await o.tick()).failed, 1); assert.equal((await o.list())[0].status, 'active', 'never silently dropped'); }
  assert.deepEqual(await o.tick(), { applied: 0, ended: 1, failed: 0 });
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});

test('a start that keeps failing is eventually marked failed, but only if nothing was applied', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  gw.upsert = async () => { throw new Error('gateway 500'); };
  for (let i = 0; i < 4; i++) await o.tick();
  const f = (await o.list())[0]; assert.equal(f.status, 'failed'); assert.match(f.note, /could not apply/); assert.equal(f.targetCents, null);
  assert.equal(personal(gw, 'u1', 'weekly'), null);
});

test('a lost-response upsert (applied but threw) is detected, not failed', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  const real = gw.upsert;
  gw.upsert = async (...a) => { await real(...a); throw new Error('timeout'); };
  for (let i = 0; i < 4; i++) await o.tick();
  assert.equal((await o.list())[0].status, 'active');
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
  gw.upsert = real; clock.advance(24 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});

test('list filters, ordering, and per-user view', async () => {
  const { clock, o, mk } = await setup();
  const a = await o.create(mk(), ADMIN); clock.advance(1000);
  const b = await o.create(mk({ sub: 'u2' }), ADMIN); clock.advance(1000);
  await o.cancel(a.id, ADMIN);
  assert.deepEqual((await o.list()).map((x) => x.id), [b.id, a.id], 'newest first');
  assert.deepEqual((await o.list({ status: 'scheduled' })).map((x) => x.id), [b.id]);
  assert.deepEqual((await o.list({ status: 'scheduled,cancelled' })).length, 2);
  assert.deepEqual((await o.list({ status: ['active'] })), []);
  await rejects(o.list({ status: 'weird' }), 400);
  assert.deepEqual((await o.forUser('u1')).map((x) => x.id), [a.id]);
});

test('no key configured: boosts are refused up front (fail closed), nothing crashes', async () => {
  const clock = fakeClock(); const gw = await seededGateway(clock);
  const cfg = { ...testCfg(), systemKey: '', writeKey: '', admins: [], demo: false };
  const o = createOverrides({ store: memStore(), gateway: gw, cfg, now: clock.now, log: silent });
  await rejects(o.create({ sub: 'u1', period: 'weekly', extraUsd: 5, startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H), reason: 'no key' }, ADMIN), 500, /write key/);
  assert.equal(personal(gw, 'u1', 'weekly'), null);
});

test('logs are structured JSON without free-text reasons', async () => {
  const lines = []; const clock = fakeClock(); const gw = await seededGateway(clock);
  const o = createOverrides({ store: memStore(), gateway: gw, cfg: testCfg(), now: clock.now, log: (x) => lines.push(JSON.stringify(x)) });
  await o.create({ sub: 'u1', period: 'weekly', extraUsd: 5, startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H), reason: 'secret-ish reason text' }, ADMIN);
  clock.advance(2 * H); await o.tick(); clock.advance(2 * H); await o.tick();
  const evts = lines.map((l) => JSON.parse(l).evt);
  assert.deepEqual(evts, ['override.created', 'override.applied', 'override.ended']);
  assert.ok(!lines.join('').includes('secret-ish'));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Data-integrity regressions (adversarial review H1, L1, L2, L9, L10, L12, F5, M5). Each fails on the previous behaviour.
// ---------------------------------------------------------------------------------------------------------------------------------
const SYS = { key: 'k', actor: 'bob@example.com' };
const U1 = { type: 'user', user_id: 'u1' };
const flaky = (gw, method, failures) => { const real = gw[method].bind(gw); let n = failures; gw[method] = async (...a) => { if (n-- > 0) throw new Error('gateway 503'); return real(...a); }; };

test('H1: adjacent boosts + one failed revert never leave a permanently boosted cap', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 25 * H), extraUsd: 50 }), ADMIN);
  await o.create(mk({ startsAt: isoAt(clock, 25 * H), endsAt: isoAt(clock, 49 * H), extraUsd: 30 }), ADMIN);   // adjacent: allowed by the overlap check
  clock.advance(2 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000');
  clock.advance(23 * H + 60e3); flaky(gw, 'remove', 1);                                    // A is due to end AND B due to start; A's revert hits a 503
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 1 });
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000', 'B did NOT stack on top of the still-boosted cap');
  const mid = await o.list();
  assert.equal(mid.find((x) => x.extraCents === 3000).status, 'scheduled'); assert.match(mid.find((x) => x.extraCents === 3000).note, /waiting for an earlier boost/);
  assert.equal(mid.find((x) => x.extraCents === 5000).overdue, true, 'A is visibly overdue');
  assert.deepEqual(await o.tick(), { applied: 1, ended: 1, failed: 0 });                // next tick: A reverts, then B reads the restored cap
  assert.equal(personal(gw, 'u1', 'weekly').amount, '18000', 'org default 15000 + 30, not 20000 + 30');
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null, 'back to no personal limit, exactly as before the first boost');
  assert.deepEqual((await o.list()).map((x) => x.status), ['ended', 'ended']);
});

test('H1: a boost that can never start because the earlier one cannot be reverted expires unapplied (never stacks)', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 5 * H), extraUsd: 50 }), ADMIN);
  await o.create(mk({ startsAt: isoAt(clock, 5 * H), endsAt: isoAt(clock, 9 * H), extraUsd: 30 }), ADMIN);
  clock.advance(2 * H); await o.tick();
  gw.remove = async () => { throw new Error('gateway down'); };
  clock.advance(10 * H);
  for (let i = 0; i < 3; i++) await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000', 'only the first boost is applied');
  const all = await o.list(), a = all.find((x) => x.extraCents === 5000), b = all.find((x) => x.extraCents === 3000);
  assert.equal(a.status, 'active'); assert.equal(a.overdue, true); assert.ok(a.overdueMs >= 7 * H);
  assert.equal(b.status, 'failed'); assert.match(b.note, /passed/);
});

test('M5: overdue is part of the API shape (active past endsAt), logged as a warning on every tick; not set otherwise', async () => {
  const lines = []; const clock = fakeClock(); const gw = await seededGateway(clock);
  const o = createOverrides({ store: memStore(), gateway: gw, cfg: testCfg(), now: clock.now, log: (x) => lines.push(x) });
  await o.create({ sub: 'u1', period: 'weekly', extraUsd: 5, startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H), reason: 'overdue' }, ADMIN);
  clock.advance(2 * H); await o.tick();
  let x = (await o.list())[0]; assert.equal(x.overdue, false); assert.equal(x.overdueMs, 0);
  gw.remove = async () => { throw new Error('gateway 500'); };
  clock.advance(2 * H + 30 * 60e3);
  await o.tick(); await o.tick();
  x = (await o.list())[0]; assert.equal(x.status, 'active'); assert.equal(x.overdue, true); assert.equal(x.overdueMs, 90 * 60e3);
  const warns = lines.filter((l) => l.evt === 'override.overdue');
  assert.equal(warns.length, 2, 'one structured warning per tick'); assert.equal(warns[0].level, 'warn'); assert.equal(warns[0].id, x.id);
  assert.equal(x.claim, undefined, 'lease internals stay private');
});

test('L10: a start that exhausted its retries is `failed` + retryable, and retry() puts it back in the queue', async () => {
  const { clock, gw, o, mk } = await setup();
  const made = await o.create(mk(), ADMIN); clock.advance(3 * H);
  const real = gw.upsert.bind(gw); gw.upsert = async () => { throw new Error('gateway 500'); };
  for (let i = 0; i < 4; i++) await o.tick();
  let x = (await o.list())[0]; assert.equal(x.status, 'failed'); assert.equal(x.retryable, true);
  await rejects(o.retry('ovr_000000000000', ADMIN), 404);
  gw.upsert = real;
  const r = await o.retry(made.id, ADMIN);                                              // the gateway is back: one admin click
  assert.equal(r.status, 'active'); assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000'); assert.equal(r.retryable, false);
  await rejects(o.retry(made.id, ADMIN), 409, /only a failed boost/);
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null); assert.equal((await o.list())[0].status, 'ended');
});

test('L10: retry() refuses a boost whose window is over and one that now overlaps another live boost', async () => {
  const { clock, gw, o, mk } = await setup();
  const a = await o.create(mk(), ADMIN); clock.advance(3 * H);
  gw.upsert = async () => { throw new Error('gateway 500'); };
  for (let i = 0; i < 4; i++) await o.tick();
  assert.equal((await o.list())[0].status, 'failed');
  const b = await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 20 * H) }), ADMIN);   // takes the slot (failed ones free it)
  await rejects(o.retry(a.id, ADMIN), 409, /overlaps/);
  await o.cancel(b.id, ADMIN);
  clock.advance(30 * H);
  await rejects(o.retry(a.id, ADMIN), 409, /passed/);
  assert.equal((await o.list()).find((x) => x.id === a.id).retryable, false);
});

test('L1: an admin edit that lands between planning and the write is not overwritten (boost fails, hand value kept)', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  const realEff = gw.effective.bind(gw); let injected = false;
  gw.effective = async (...a) => { const r = await realEff(...a); if (!injected) { injected = true; await gw.upsert(U1, 'weekly', 12000, SYS); } return r; };   // edit right after the plan's reads
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 1 });
  assert.equal(personal(gw, 'u1', 'weekly').amount, '12000', "the admin's $120 survives");
  const x = (await o.list())[0]; assert.equal(x.status, 'failed'); assert.match(x.note, /changed by hand before/);
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '12000', 'and nothing "restores" over it later');
});

test('L1 (symmetric): at the end a cap that no longer equals the target is never overwritten, one back at prev is just noted', async () => {
  for (const [hand, status, kept] of [[31000, 'superseded', '31000'], [8000, 'ended', '8000']]) {
    const { clock, gw, o, mk } = await setup();
    await gw.upsert(U1, 'weekly', 8000, SYS);
    await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
    await gw.upsert(U1, 'weekly', hand, SYS);                                          // no reconcile(): the revert itself must notice
    clock.advance(24 * H); await o.tick();
    assert.equal(personal(gw, 'u1', 'weekly').amount, kept); assert.equal((await o.list())[0].status, status);
  }
});

test('L2: raising the org default during a boost re-targets it (boosted user is never below everyone); the end deletes the personal cap', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
  await gw.upsert({ type: 'organization' }, 'weekly', 30000, SYS);
  await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '35000', 'new default 300 + the 50 boost');
  assert.equal((await o.list())[0].targetCents, 35000); assert.equal((await o.list())[0].status, 'active');
  await gw.upsert({ type: 'organization' }, 'weekly', 10000, SYS); await o.tick();
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000', 'lowering follows too');
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null); assert.equal(await effAmount(gw, 'u1', 'weekly'), '10000', 'user follows the current default again');
  assert.equal((await o.list())[0].status, 'ended');
});

test('L2: a crash between re-planning and the write is recovered (the old target still counts as ours)', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H); await o.tick();
  await gw.upsert({ type: 'organization' }, 'weekly', 30000, SYS);
  const real = gw.upsert.bind(gw); gw.upsert = async () => { throw new Error('gateway 503'); };
  await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000'); assert.equal((await o.list())[0].status, 'active', 'not superseded');
  gw.upsert = real; clock.advance(10 * 60e3); await o.tick();                           // lease from the failed attempt expired
  assert.equal(personal(gw, 'u1', 'weekly').amount, '35000');
  clock.advance(24 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly'), null);
});

test('L2: org default becoming unlimited ends the boost early; an explicit personal cap is never touched by org changes and is restored exactly', async () => {
  const a = await setup();
  await a.o.create(a.mk(), ADMIN); a.clock.advance(3 * H); await a.o.tick();
  await a.gw.remove((await a.gw.listLimits()).find((l) => l.scope.type === 'organization' && l.period === 'weekly').id, SYS);
  await a.o.tick();
  assert.equal(personal(a.gw, 'u1', 'weekly'), null); const x = (await a.o.list())[0]; assert.equal(x.status, 'ended'); assert.match(x.note, /unlimited/);

  const b = await setup();
  await b.gw.upsert(U1, 'weekly', 8000, SYS);                                          // deliberately below the org default
  await b.o.create(b.mk(), ADMIN); b.clock.advance(3 * H); await b.o.tick();
  await b.gw.upsert({ type: 'organization' }, 'weekly', 30000, SYS); await b.o.tick();
  assert.equal(personal(b.gw, 'u1', 'weekly').amount, '13000', 'a personal base is not re-based on the org default');
  b.clock.advance(24 * H); await b.o.tick();
  assert.equal(personal(b.gw, 'u1', 'weekly').amount, '8000', 'restored exactly (a lower personal cap is a deliberate restriction)');
});

test('N11/F5: a removed admin\'s SCHEDULED boosts are cancelled, their ACTIVE boosts run to their end (flagged + warned); local single-admin mode is exempt', async () => {
  const lines = []; const { clock, gw, cfg, store, mk } = await setup();
  const o = createOverrides({ store, gateway: gw, cfg, now: clock.now, log: (x) => lines.push(x) });
  await o.create(mk({ startsAt: isoAt(clock, H), endsAt: isoAt(clock, 10 * H) }), { email: 'bob@example.com' });                         // active soon
  await o.create(mk({ sub: 'u2', startsAt: isoAt(clock, 20 * H), endsAt: isoAt(clock, 30 * H) }), { email: 'bob@example.com' });         // still scheduled
  await o.create(mk({ sub: 'u3', period: 'monthly', startsAt: isoAt(clock, 20 * H), endsAt: isoAt(clock, 40 * H) }), ADMIN);             // another admin's, kept
  clock.advance(2 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000');
  cfg.admins = cfg.admins.filter((a) => a.email !== 'bob@example.com');                  // bob leaves (or APP_ADMINS has a typo)
  await o.tick(); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000', 'the active boost is NOT cut off');
  const by = Object.fromEntries((await o.list()).map((x) => [x.sub, x]));
  assert.equal(by.u1.status, 'active'); assert.equal(by.u1.creatorRemoved, true);
  assert.equal(by.u2.status, 'cancelled'); assert.match(by.u2.note, /creator removed/); assert.equal(by.u2.creatorRemoved, false);
  assert.equal(by.u3.status, 'scheduled', "ada's boost is untouched"); assert.equal(by.u3.creatorRemoved, false);
  const warns = lines.filter((l) => l.evt === 'override.creator-removed');
  assert.equal(warns.length, 2, 'one warning per tick while it runs'); assert.equal(warns[0].level, 'warn'); assert.equal(warns[0].id, by.u1.id); assert.equal(warns[0].by, 'bob@example.com');
  cfg.admins.push({ email: 'bob@example.com' });                                          // he comes back: the flag clears
  await o.tick(); assert.equal((await o.list()).find((x) => x.sub === 'u1').creatorRemoved, false);
  cfg.admins = cfg.admins.filter((a) => a.email !== 'bob@example.com');
  clock.advance(9 * H); await o.tick();                                                    // the scheduled end still reverts it
  assert.equal(personal(gw, 'u1', 'weekly'), null); assert.equal((await o.list()).find((x) => x.sub === 'u1').status, 'ended');

  const local = await setup({ admins: [], writeKey: 'wk-local' });                       // local single-admin mode: nobody is "removed"
  await local.o.create(local.mk({ startsAt: isoAt(local.clock, H) }), { email: 'whoever' }); local.clock.advance(2 * H); await local.o.tick();
  assert.equal((await local.o.list())[0].status, 'active'); assert.equal((await local.o.list())[0].creatorRemoved, false);
});

test('F5: accounts mode fails closed without the system key (never borrows an admin personal key); local mode may use its single key', async () => {
  const clock = fakeClock(); const gw = await seededGateway(clock);
  const noSys = { ...testCfg(), systemKey: '', demo: false };                            // admins have writeKeys, there is no system key
  assert.ok(noSys.admins.length && noSys.admins[0].writeKey);
  const o = createOverrides({ store: memStore(), gateway: gw, cfg: noSys, now: clock.now, log: silent });
  await rejects(o.create({ sub: 'u1', period: 'weekly', extraUsd: 5, startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H), reason: 'no system key' }, ADMIN), 500, /GATEWAY_SYSTEM_WRITE_KEY/);
  const keys = []; const spy = new Proxy(gw, { get: (t, k) => (k === 'upsert' ? (async (s, p, c, who) => { keys.push(who.key); return t.upsert(s, p, c, who); }) : t[k]) });
  const local = createOverrides({ store: memStore(), gateway: spy, cfg: { ...testCfg(), systemKey: '', admins: [], writeKey: 'wk-local', demo: false }, now: clock.now, log: silent });
  await local.create({ sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(clock, 3 * H), reason: 'local mode' }, ADMIN);
  assert.deepEqual(keys, ['wk-local']);
  const spy2 = []; const sys = createOverrides({ store: memStore(), gateway: new Proxy(gw, { get: (t, k) => (k === 'upsert' ? (async (s, p, c, who) => { spy2.push([who.key, who.actor]); return t.upsert(s, p, c, who); }) : t[k]) }), cfg: testCfg(), now: clock.now, log: silent });
  await sys.create({ sub: 'u2', period: 'weekly', extraUsd: 5, endsAt: isoAt(clock, 3 * H), reason: 'with system key' }, ADMIN);
  assert.deepEqual(spy2, [[testCfg().systemKey, 'system:overrides']], 'the system key and actor, never ada/bob');
  assert.equal((await sys.list())[0].createdBy, 'ada@example.com', 'the person is on the override record');
});

test('L9: control, zero-width and bidi-override characters are stripped from reasons before storing', async () => {
  const { clock, o, mk } = await setup();
  const c = (...n) => String.fromCharCode(...n);
  const made = await o.create(mk({ reason: `on${c(0x202e)}-call${c(0x200b)} \n\t week${c(0x0000)}${c(0x2066)}` }), ADMIN);
  assert.equal(made.reason, 'on -call week');
  await rejects(o.create(mk({ sub: 'u2', reason: `ab${c(0x202e)}` }), ADMIN), 400, /reason/);
  await rejects(o.create(mk({ sub: 'u2', reason: c(0x200b, 0x200b, 0x200b, 0x200b) }), ADMIN), 400, /reason/);
  assert.ok(clock);
});

test('amounts: only plain decimals with at most two places are accepted ("1e3", "0x10", 1.005, " 12 " are not)', async () => {
  const { o, mk } = await setup();
  for (const v of ['1e3', '0x10', ' 12 ', '1_0', 1.005, '1.005', '-5', '.5', '12.', 'Infinity']) await rejects(o.create(mk({ extraUsd: v }), ADMIN), 400, /extra amount/);
  const ok = await o.create(mk({ extraUsd: '12.50' }), ADMIN); assert.equal(ok.extraCents, 1250);
  const ok2 = await o.create(mk({ sub: 'u2', extraUsd: 19.99 }), ADMIN); assert.equal(ok2.extraCents, 1999);
});

test('L12: a lease stamped far in the future (skewed clock) is not honoured for hours; a near-future one is', async () => {
  const { clock, gw, store, o, mk } = await setup();
  await o.create(mk(), ADMIN); clock.advance(3 * H);
  await store.update('overrides', (d) => { d.items[0].claim = { id: 'skewed', at: clock.t + 2 * H, kind: 'start' }; return d; });
  assert.deepEqual(await o.tick(), { applied: 1, ended: 0, failed: 0 });
  const t2 = await setup(); await t2.o.create(t2.mk(), ADMIN); t2.clock.advance(3 * H);
  await t2.store.update('overrides', (d) => { d.items[0].claim = { id: 'peer', at: t2.clock.t + 60e3, kind: 'start' }; return d; });
  assert.deepEqual(await t2.o.tick(), { applied: 0, ended: 0, failed: 0 }, 'a peer whose clock is 1 minute ahead still holds its lease');
  assert.ok(gw);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Round 2 (N1 compare-before-write, N2 idle ticks and budgets, N3 zombies, N5/N12 leases, N7 shape). Each fails on the round-1 code.
// ---------------------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore, StoreError } from '../lib/store.mjs';

test('N1: a hand edit between the retarget read and its write is never overwritten (boost superseded, edit survives the end)', async () => {
  const { clock, gw, store, cfg, mk } = await setup();
  let armed = 0;
  const hooked = { ...store, get: store.get, put: store.put, list: store.list, update: async (...a) => {
    if (armed === 1) { armed = 2; await gw.upsert(U1, 'weekly', 33333, SYS); }                // lands right after the tick's single limits read, before its first write
    return store.update(...a);
  } };
  const realList = gw.listLimits.bind(gw); gw.listLimits = async () => { const r = await realList(); if (armed === 0) armed = 1; return r; };
  const o = createOverrides({ store: hooked, gateway: gw, cfg, now: clock.now, log: silent });
  await o.create(mk({ startsAt: isoAt(clock, 0) }), ADMIN);
  assert.equal(personal(gw, 'u1', 'weekly').amount, '20000'); armed = -1;
  await gw.upsert({ type: 'organization' }, 'weekly', 20000, SYS);                         // org default raised: the tick wants to retarget 20000 -> 25000
  clock.advance(60e3); armed = 0;
  await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '33333', 'the hand edit was not overwritten');
  assert.equal((await o.list())[0].status, 'superseded');
  clock.advance(49 * H); await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '33333', 'and the end of the boost does not wipe it');
});

test('N1: the revert reads the live cap right before its write (a hand edit that lands just before it is kept)', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk({ startsAt: isoAt(clock, 0), endsAt: isoAt(clock, 3 * H) }), ADMIN);
  clock.advance(4 * H);
  const realEff = gw.effective.bind(gw); let injected = false;
  gw.effective = async (...a) => { if (!injected) { injected = true; await gw.upsert(U1, 'weekly', 44444, SYS); } return realEff(...a); };   // the first live read of this tick sees the edit
  await o.tick();
  assert.equal(personal(gw, 'u1', 'weekly').amount, '44444'); assert.equal((await o.list())[0].status, 'superseded');
});

test('N1: the retarget path never writes when the live cap is not the one it planned from', async () => {
  const { clock, gw, o, mk } = await setup();
  await o.create(mk({ startsAt: isoAt(clock, 0) }), ADMIN);
  await gw.upsert({ type: 'organization' }, 'weekly', 20000, SYS); clock.advance(60e3);
  const writes = []; const real = gw.upsert.bind(gw); gw.upsert = async (...a) => { writes.push(a[2]); return real(...a); };
  const realEff = gw.effective.bind(gw); let n = 0;
  gw.effective = async (...a) => { if (++n === 1) await real(U1, 'weekly', 55555, SYS); return realEff(...a); };   // edit lands before the pre-write read
  await o.tick();
  assert.deepEqual(writes, [], 'no system write at all'); assert.equal(personal(gw, 'u1', 'weekly').amount, '55555'); assert.equal((await o.list())[0].status, 'superseded');
});

test('N2: an idle tick with 1000 active boosts does one store read, one limits read, and ZERO writes (file store)', async () => {
  const N = 1000, clock = fakeClock(), gw = await seededGateway(clock);
  const items = [];
  for (let i = 0; i < N; i++) {
    const sub = 'idle' + i;
    gw.users.push({ sub, email: `${sub}@x.io`, name: sub });
    await gw.upsert({ type: 'user', user_id: sub }, 'weekly', 20000, SYS);
    items.push({ id: 'ovr_' + String(i).padStart(12, '0'), sub, email: `${sub}@x.io`, name: sub, period: 'weekly', extraCents: 5000, baseCents: 15000, targetCents: 20000, baseSource: 'organization', prev: { kind: 'none' },
      startsAt: new Date(clock.t - H).toISOString(), endsAt: new Date(clock.t + 48 * H).toISOString(), reason: 'launch', createdBy: 'ada@example.com', createdAt: new Date(clock.t - 2 * H).toISOString(), status: 'active', appliedAt: new Date(clock.t - H).toISOString(), endedAt: null, note: null });
  }
  const fsStore = createFileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-'))); await fsStore.put('overrides', { items });
  const calls = { update: 0, get: 0, listLimits: 0, effective: 0, upsert: 0, remove: 0 };
  const store = { ...fsStore, get: (...a) => { calls.get++; return fsStore.get(...a); }, update: (...a) => { calls.update++; return fsStore.update(...a); } };
  const counted = new Proxy(gw, { get: (t, k) => (k in calls && typeof t[k] === 'function' ? (...a) => { calls[k]++; return t[k](...a); } : t[k]) });
  const o = createOverrides({ store, gateway: counted, cfg: testCfg(), now: clock.now, log: silent });
  const t0 = Date.now(); const r = await o.tick();
  assert.deepEqual(r, { applied: 0, ended: 0, failed: 0 });
  assert.deepEqual(calls, { update: 0, get: 1, listLimits: 1, effective: 0, upsert: 0, remove: 0 });
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
});

test('N2: due work is done in batches under a per-tick budget; the rest carries over to the next ticks (200 boosts, file store)', async () => {
  const N = 200, clock = fakeClock(), gw = await seededGateway(clock);
  const items = [];
  for (let i = 0; i < N; i++) {
    const sub = 'b' + i; gw.users.push({ sub, email: `${sub}@x.io`, name: sub });
    await gw.upsert({ type: 'user', user_id: sub }, 'weekly', 20000, SYS);
    items.push({ id: 'ovr_' + String(i).padStart(12, '0'), sub, email: `${sub}@x.io`, name: sub, period: 'weekly', extraCents: 5000, baseCents: 15000, targetCents: 20000, baseSource: 'organization', prev: { kind: 'none' },
      startsAt: new Date(clock.t - 2 * H).toISOString(), endsAt: new Date(clock.t + H).toISOString(), reason: 'launch', createdBy: 'ada@example.com', createdAt: new Date(clock.t - 3 * H).toISOString(), status: 'active', appliedAt: new Date(clock.t - 2 * H).toISOString(), endedAt: null, note: null });
  }
  const store = createFileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'))); await store.put('overrides', { items });
  const o = createOverrides({ store, gateway: gw, cfg: testCfg(), now: clock.now, log: silent, budgetMs: 0 });   // a zero budget = exactly one batch per phase and tick
  clock.advance(2 * H);
  let total = 0; const per = [];
  for (let i = 0; i < 30 && total < N; i++) { const r = await o.tick(); per.push(r.ended); total += r.ended; }
  assert.equal(total, N); assert.ok(per.every((n) => n <= 20), 'at most one batch of 20 per tick: ' + per.join(','));
  assert.ok(per.filter((n) => n > 0).length >= 10, 'spread over many ticks');
  assert.equal(gw.limits.filter((l) => l.scope.type === 'user').length, 0, 'every personal cap was reverted');
  assert.deepEqual(await o.tick(), { applied: 0, ended: 0, failed: 0 });
});

test('N3: an active boost whose cap was already restored (final record write failed) is closed by the next tick, even org-default-removed -> early end', async () => {
  const { clock, gw, store, cfg, mk } = await setup();
  let failNext = false;
  const flakyStore = { ...store, get: store.get, put: store.put, list: store.list, update: async (...a) => { if (failNext) { failNext = false; throw new Error('storage conflict (injected)'); } return store.update(...a); } };
  const realRemove = gw.remove.bind(gw); gw.remove = async (id, who) => { const r = await realRemove(id, who); if (who.actor === 'system:overrides') failNext = true; return r; };
  const o = createOverrides({ store: flakyStore, gateway: gw, cfg, now: clock.now, log: silent });
  await o.create(mk({ startsAt: isoAt(clock, 0), endsAt: isoAt(clock, 30 * D) }), ADMIN);
  const org = (await gw.listLimits()).find((l) => l.scope.type === 'organization' && l.period === 'weekly'); await realRemove(org.id, SYS);   // company default deleted: everyone unlimited
  await o.tick().catch(() => {});
  assert.equal(personal(gw, 'u1', 'weekly'), null, 'the early end removed the personal cap');
  assert.equal((await o.list())[0].status, 'active', 'but the record write failed once: a zombie');
  await gw.upsert({ type: 'organization' }, 'weekly', 15000, SYS);                          // the default comes back
  clock.advance(6 * 60e3); const r = await o.tick();
  const x = (await o.list())[0];
  assert.equal(x.status, 'ended'); assert.match(x.note, /already back/); assert.equal(r.ended, 1);
  assert.equal(personal(gw, 'u1', 'weekly'), null);
  await o.create(mk({ startsAt: isoAt(clock, 0), endsAt: isoAt(clock, 2 * D) }), ADMIN);   // a replacement is no longer blocked by the zombie
});

test('N3: every tick reconciles every active boost: restored by hand -> ended, changed by hand -> superseded, untouched -> healthy (no writes)', async () => {
  const { clock, gw, o, mk } = await setup();
  for (const [sub, extra] of [['u1', 50], ['u2', 40], ['u3', 30]]) await o.create(mk({ sub, startsAt: isoAt(clock, 0), endsAt: isoAt(clock, 20 * H), extraUsd: extra }), ADMIN);
  await gw.remove(personal(gw, 'u1', 'weekly').id, SYS);                                    // someone put u1 back to "no personal limit" (= the pre-boost value)
  await gw.upsert({ type: 'user', user_id: 'u2' }, 'weekly', 77777, SYS);                   // someone set u2 to something else
  clock.advance(60e3);                                                                      // no reconcile() call, no end time reached
  const r = await o.tick();
  const by = Object.fromEntries((await o.list()).map((x) => [x.sub, x]));
  assert.equal(by.u1.status, 'ended'); assert.equal(by.u2.status, 'superseded'); assert.equal(by.u3.status, 'active');
  assert.equal(r.ended, 1); assert.equal(personal(gw, 'u2', 'weekly').amount, '77777'); assert.equal(personal(gw, 'u3', 'weekly').amount, '18000');
});

test('N5: a wall-clock step bigger than the lease in the middle of a tick: our own lease is judged on the monotonic clock, and a takeover is detected before the write', async () => {
  // (a) the wall clock jumps +1h inside our own tick; nobody else is working: we finish normally
  const a = await setup(); let mono = 0;
  const oa = createOverrides({ store: a.store, gateway: a.gw, cfg: a.cfg, now: a.clock.now, log: silent, mono: () => mono });
  await oa.create(a.mk({ startsAt: isoAt(a.clock, 0) }), ADMIN);
  a.clock.advance(30 * H);
  const realEff = a.gw.effective.bind(a.gw); let jumped = false;
  a.gw.effective = async (...x) => { if (!jumped) { jumped = true; a.clock.advance(H); } return realEff(...x); };
  await oa.tick();
  assert.equal(personal(a.gw, 'u1', 'weekly'), null); assert.equal((await oa.list())[0].status, 'ended');

  // (b) worker A claims the end, the wall clock then jumps 10 min; worker B (sharing the store) sees A's lease expired and takes the item over.
  //     A must notice before it writes: exactly one revert reaches the gateway.
  const b = await setup();
  const A = createOverrides({ store: b.store, gateway: b.gw, cfg: b.cfg, now: b.clock.now, log: silent });
  const B = createOverrides({ store: b.store, gateway: b.gw, cfg: b.cfg, now: b.clock.now, log: silent });
  await A.create(b.mk({ startsAt: isoAt(b.clock, 0), endsAt: isoAt(b.clock, 3 * H) }), ADMIN);
  b.clock.advance(4 * H);
  const removes = []; const realRemove = b.gw.remove.bind(b.gw); b.gw.remove = async (...x) => { removes.push(x[0]); return realRemove(...x); };
  const realStoreGet = b.store.get.bind(b.store); let calls = 0, took = false;
  b.store.get = async (...x) => { const r = await realStoreGet(...x); if (++calls === 4 && !took) { took = true; b.clock.advance(10 * 60e3); await B.tick(); } return r; };   // inside A's tick, after its claim
  await A.tick();
  assert.equal(removes.length, 1, 'only one worker reverted: ' + removes.length);
  assert.equal(personal(b.gw, 'u1', 'weekly'), null); assert.equal((await A.list())[0].status, 'ended');
});

test('N7: valid JSON of the wrong shape is damage, not "no overrides" (list, tick and create all fail loudly; the file is left alone and copied)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-')); const store = createFileStore(dir);
  const { clock, gw, cfg, mk } = await setup(); const o = createOverrides({ store, gateway: gw, cfg, now: clock.now, log: silent });
  for (const bad of ['{}', 'null', '{"items":null}', '[]', '{"items":[1]}', '{"items":[{"id":5}]}', '"x"']) {
    fs.writeFileSync(path.join(dir, 'overrides.json'), bad);
    for (const call of [() => o.list(), () => o.tick(), () => o.create(mk(), ADMIN), () => o.forUser('u1')]) await assert.rejects(call(), (e) => e instanceof StoreError && /unexpected shape/.test(e.message), bad);
    assert.equal(fs.readFileSync(path.join(dir, 'overrides.json'), 'utf8'), bad, 'no silent overwrite');
  }
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('overrides.json.corrupt-')), 'a copy was kept for the operator');
  fs.writeFileSync(path.join(dir, 'overrides.json'), '{"items":[]}'); assert.deepEqual(await o.list(), []);
  // a store that ignores the shape option (a wrapper) is still protected by the module itself
  const dumb = { get: async () => ({}), update: async (n, fn, fb) => fn({}), put: async () => {}, list: async () => [] };
  await assert.rejects(createOverrides({ store: dumb, gateway: gw, cfg, now: clock.now, log: silent }).list(), StoreError);
});
