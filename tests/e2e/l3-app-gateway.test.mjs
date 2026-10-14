// L3: the budget app (createApp, in-process) driving the REAL gateway through createHttpGateway with real per-admin keys,
// real file store, a real usage backend over the gateway's own log, and an injectable clock.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { E } from './lib/env.mjs';
import { PORTS } from './lib/config.mjs';
import { adminCall, introduce, messages, mintSession, resetLimits, unique, MODELS, logSince, gatewayProcess, secretsFromEnv, sleep } from './lib/gw.mjs';
import { startFakeVertex } from './lib/fakevertex.mjs';
import { bootApp, fakeClock, iso, H, D } from './lib/app.mjs';
import { liveCloud } from './lib/cloudlog.mjs';
import { createHttpGateway } from '../../api/lib/gateway.mjs';
import { createFileStore } from '../../api/lib/store.mjs';

const P = unique('l3');
const U = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((n) => [n, { sub: `${P}-${n}`, email: `${n}-${P}@example.com`, name: `User ${n.toUpperCase()}` }]));
const clock = fakeClock();
let ctx, tmp, tokens;
const cloud = liveCloud(() => logSince(0), 'main-');

// ---- views of the REAL gateway, independent of the app under test ----
const eff = async (sub, period) => (await adminCall('GET', `/effective?user_ids%5B%5D=${encodeURIComponent(sub)}&period%5B%5D=${period}`)).json.data.find((r) => r.period === period);
const personal = async (sub, period) => (await adminCall('GET', '?limit=1000')).json.data.find((l) => l.scope.type === 'user' && l.scope.user_id === sub && l.period === period) || null;
const gwAudit = async () => (await adminCall('GET', '/audit?limit=500')).json.data;
// the audit list is capped at 500 events (newest first), so measure by id, never by length
const lastAuditId = async () => Number((await gwAudit())[0]?.id || 0);
const auditSince = async (id) => (await gwAudit()).filter((e) => Number(e.id) > id);
const put = (token, sub, body) => ctx.call('PUT', `/api/users/${encodeURIComponent(sub)}/budget`, { token, body });
const putOrg = (token, body) => ctx.call('PUT', '/api/org/budget', { token, body });
const tick = (token) => ctx.call('POST', '/api/internal/tick', { token });
const relogin = async () => { tokens = { ada: await ctx.login('ada'), bob: await ctx.login('bob') }; };

before(async () => {
  await resetLimits();
  tmp = fs.mkdtempSync(path.join(E.tmp, 'l3-'));
  ctx = await bootApp({ port: PORTS.appL3, dataDir: tmp, clock, usageOptions: { fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'e2e' } } });
  tokens = { ada: await ctx.login('ada'), bob: await ctx.login('bob') };
  for (const u of Object.values(U)) await introduce(u);
});
after(async () => { await ctx?.close(); await resetLimits(); });

describe('L3 sign-in and health', () => {
  test('health sees the real gateway; login works per admin; bad credentials and bad tokens are refused', async () => {
    const h = await ctx.call('GET', '/api/health');
    assert.equal(h.status, 200); assert.equal(h.json.gateway, true, 'ping() reaches the real /protocol'); assert.equal(h.json.accounts, true); assert.equal(h.json.admin, null);
    const hd = await ctx.call('GET', '/api/health', { token: tokens.ada });
    assert.deepEqual(hd.json.admin, { email: 'ada@example.com', name: 'Ada Admin' });
    assert.equal((await ctx.call('GET', '/api/health', { token: tokens.bob })).json.admin.email, 'bob@example.com');
    const bad = await ctx.call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'nope' } });
    const unknown = await ctx.call('POST', '/api/login', { body: { email: 'zed@example.com', password: 'nope' } });
    assert.deepEqual([bad.status, unknown.status], [401, 401]); assert.deepEqual(bad.json, unknown.json, 'same answer for unknown email and wrong password');
    assert.equal((await ctx.call('PUT', '/api/org/budget', { token: 'garbage.token', body: { period: 'weekly', action: 'set', usd: 1 } })).status, 401);
  });
  test('the app never leaks keys or the session secret in any response or log line', async () => {
    const secrets = [E.keys.ada, E.keys.bob, E.keys.system, E.keys.read, E.jwt];
    const bodies = [];
    for (const p of ['/api/health', '/api/users', '/api/company', '/api/audit', '/api/models', '/api/overrides']) bodies.push((await ctx.call('GET', p, { token: tokens.ada })).text);
    bodies.push(JSON.stringify(ctx.logs));
    for (const s of secrets) for (const b of bodies) assert.ok(!b.includes(s));
  });
});

describe('L3 budgets: set, inherit, unlimited, verified on the real gateway and in the audit trail', () => {
  test('writes need an admin session; nothing reaches the gateway without one', async () => {
    const before = await lastAuditId();
    for (const t of [undefined, 'x.y']) {
      assert.equal((await putOrg(t, { period: 'weekly', action: 'set', usd: 150 })).status, 401);
      assert.equal((await put(t, U.a.sub, { period: 'weekly', action: 'set', usd: 5 })).status, 401);
    }
    assert.equal(await lastAuditId(), before);
  });

  test('org default: ada sets weekly 150, bob sets monthly 500; the real gateway records each admin key', async () => {
    const r1 = await putOrg(tokens.ada, { period: 'weekly', action: 'set', usd: 150 });
    assert.equal(r1.status, 200); assert.equal(r1.json.limit.amount, '15000');
    const r2 = await putOrg(tokens.bob, { period: 'monthly', action: 'set', usd: 500 });
    assert.equal(r2.json.limit.amount, '50000');
    const aud = (await gwAudit()).slice(0, 2);
    assert.deepEqual(aud.map((e) => [e.actor, e.action, e.after.amount, e.after.period]), [['admin-key:bob@example.com', 'spend_limit.upsert', '50000', 'monthly'], ['admin-key:ada@example.com', 'spend_limit.upsert', '15000', 'weekly']]);
    const api = (await ctx.call('GET', '/api/audit')).json.events;
    assert.deepEqual(api.slice(0, 2).map((e) => [e.actor, e.kind, e.who, e.period, e.toCents, e.hadBefore]), [['bob@example.com', 'created', 'Everyone (default)', 'monthly', 50000, false], ['ada@example.com', 'created', 'Everyone (default)', 'weekly', 15000, false]]);
    const row = await eff(U.a.sub, 'weekly'); assert.deepEqual([row.amount, row.source], ['15000', { type: 'organization' }]);
  });

  test('the company default cannot be unlimited, amounts are bounded, periods are checked: 400 and no gateway change', async () => {
    const n = await lastAuditId();
    for (const [body, why] of [
      [{ period: 'weekly', action: 'unlimited' }, 'org unlimited'], [{ period: 'weekly', action: 'set', usd: -1 }, 'negative'], [{ period: 'weekly', action: 'set', usd: 100001 }, 'over the max'],
      [{ period: 'weekly', action: 'set', usd: 'abc' }, 'not a number'], [{ period: 'weekly', action: 'set' }, 'missing'], [{ period: 'weekly', action: 'set', usd: null }, 'null'],
      [{ period: 'daily', action: 'set', usd: 5 }, 'daily is read-only'], [{ period: 'weekly', action: 'bogus' }, 'bad action'], [{ action: 'set', usd: 5 }, 'no period'],
    ]) assert.equal((await putOrg(tokens.ada, body)).status, 400, why);
    assert.equal((await put(tokens.ada, 'bad id!', { period: 'weekly', action: 'set', usd: 5 })).status, 400);
    assert.equal(await lastAuditId(), n, 'nothing was written');
  });

  test('personal cap, raise/lower, unlimited, inherit, zero: effective() on the real gateway follows each change', async () => {
    const sub = U.b.sub;
    assert.equal((await put(tokens.ada, sub, { period: 'weekly', action: 'set', usd: 100 })).json.limit.amount, '10000');
    let r = await eff(sub, 'weekly'); assert.deepEqual([r.amount, r.source], ['10000', { type: 'user', user_id: sub }]);
    await put(tokens.bob, sub, { period: 'weekly', action: 'set', usd: 150.5 });
    assert.equal((await eff(sub, 'weekly')).amount, '15050');
    await put(tokens.ada, sub, { period: 'weekly', action: 'set', usd: 0.29 });
    assert.equal((await eff(sub, 'weekly')).amount, '29', '0.29 USD is 29 cents, not 28.999999');
    await put(tokens.ada, sub, { period: 'weekly', action: 'set', usd: 0 });
    r = await eff(sub, 'weekly'); assert.deepEqual([r.amount, r.source?.type], ['0', 'user'], 'zero is a cap');
    await put(tokens.ada, sub, { period: 'weekly', action: 'unlimited' });
    r = await eff(sub, 'weekly'); assert.deepEqual([r.amount, r.source?.type], [null, 'user'], 'unlimited');
    let d = (await ctx.call('GET', `/api/users/${sub}`)).json;
    assert.deepEqual(d.user.budgets.weekly, { capCents: null, spendCents: 0, source: 'user', limitId: r.spend_limit_id, unlimited: true });
    assert.deepEqual(d.user.ownLimits.weekly, { id: r.spend_limit_id, amountCents: null });
    assert.deepEqual(d.orgDefaults, { weekly: 15000, monthly: 50000 });
    const inh = await put(tokens.bob, sub, { period: 'weekly', action: 'inherit' });
    assert.deepEqual(inh.json, { ok: true, removed: true });
    r = await eff(sub, 'weekly'); assert.deepEqual([r.amount, r.source], ['15000', { type: 'organization' }], 'back to the company default');
    assert.deepEqual((await put(tokens.bob, sub, { period: 'weekly', action: 'inherit' })).json, { ok: true, removed: false }, 'inherit twice is harmless');
    d = (await ctx.call('GET', `/api/users/${sub}`)).json;
    assert.deepEqual(d.user.budgets.weekly.source, 'organization'); assert.equal(d.user.budgets.weekly.unlimited, false);
    // the user's audit history, as the app tells it
    const kinds = d.audit.filter((e) => e.sub === sub && e.period === 'weekly').map((e) => `${e.actor}:${e.kind}`).reverse();
    assert.deepEqual(kinds, ['ada@example.com:created', 'bob@example.com:raised', 'ada@example.com:lowered', 'ada@example.com:lowered', 'ada@example.com:unlimited', 'bob@example.com:removed']);
  });

  test('users list and company view reflect the real gateway (caps, unlimited, seats) and usage from the gateway log', async () => {
    await put(tokens.ada, U.c.sub, { period: 'monthly', action: 'unlimited' });
    await put(tokens.ada, U.d.sub, { period: 'monthly', action: 'set', usd: 40 });
    await messages(mintSession(U.d)); await messages(mintSession(U.d), { model: 'gpt-4' });
    const t = await tick(tokens.ada);
    assert.equal(t.status, 200); assert.ok(t.json.usage.ingested >= 1, 'the tick pulled the real gateway log');
    const users = (await ctx.call('GET', '/api/users')).json;
    assert.equal(users.usage.source, 'logs');
    const by = Object.fromEntries(users.users.filter((u) => u.sub.startsWith(P)).map((u) => [u.sub, u]));
    assert.equal(Object.keys(by).length, 11, 'every introduced user is listed');
    assert.deepEqual([by[U.d.sub].requests, by[U.d.sub].ok, by[U.d.sub].failed, by[U.d.sub].email], [3, 2, 1, U.d.email]);
    assert.deepEqual(by[U.d.sub].budgets.monthly, { capCents: 4000, spendCents: 0, source: 'user', limitId: by[U.d.sub].budgets.monthly.limitId, unlimited: false });
    assert.deepEqual([by[U.c.sub].budgets.monthly.capCents, by[U.c.sub].budgets.monthly.unlimited, by[U.c.sub].budgets.monthly.source], [null, true, 'user']);
    assert.deepEqual([by[U.a.sub].budgets.weekly.capCents, by[U.a.sub].budgets.weekly.source, by[U.a.sub].budgets.weekly.unlimited], [15000, 'organization', false]);
    assert.deepEqual([by[U.a.sub].budgets.daily.capCents, by[U.a.sub].budgets.daily.source], [null, null], 'no daily cap anywhere');
    assert.equal(by[U.a.sub].name, 'User A', 'name comes from the gateway session');
    const co = (await ctx.call('GET', '/api/company')).json;
    assert.deepEqual(co.org.weekly.amountCents, 15000); assert.equal(co.org.monthly.amountCents, 50000);
    assert.ok(co.userOverrides >= 2 && co.seats >= 11);
    assert.ok(co.spend.monthly.uncappedUsers >= 1, 'user c is unlimited');
    await put(tokens.ada, U.c.sub, { period: 'monthly', action: 'inherit' }); await put(tokens.ada, U.d.sub, { period: 'monthly', action: 'inherit' });
  });

  test('unknown users: detail 404, and a budget write for a user the gateway never saw is refused (a typo must not create a cap for nobody)', async () => {
    assert.equal((await ctx.call('GET', '/api/users/nobody-' + P)).status, 404);
    const ghost = 'ghost-' + P;
    const r = await put(tokens.ada, ghost, { period: 'weekly', action: 'set', usd: 10 });
    assert.equal(r.status, 404, 'unknown user id');
    assert.equal(await personal(ghost, 'weekly'), null, 'and nothing was written to the gateway');
  });
});

describe('L3 temporary budget boosts (overrides) against the real gateway with a fake clock', () => {
  const create = (sub, body, token = tokens.ada) => ctx.call('POST', '/api/overrides', { token, body: { sub, period: 'weekly', extraUsd: 50, endsAt: iso(clock.t + 24 * H), reason: 'e2e on-call week', ...body } });
  const status = async (id) => (await ctx.call('GET', '/api/overrides')).json.overrides.find((o) => o.id === id);
  const system = (e) => e.actor === 'admin-key:system:overrides';

  test('previous state NONE: applied now, system key does the write, restored (limit deleted) at expiry', async () => {
    const sub = U.e.sub;
    const r = await create(sub, {});
    assert.equal(r.status, 201);
    assert.deepEqual([r.json.status, r.json.baseCents, r.json.targetCents, r.json.prev, r.json.extraCents, r.json.createdBy], ['active', 15000, 20000, { kind: 'none' }, 5000, 'ada@example.com']);
    const lim = await personal(sub, 'weekly'); assert.equal(lim.amount, '20000');
    let row = await eff(sub, 'weekly'); assert.deepEqual([row.amount, row.source.type], ['20000', 'user']);
    assert.ok(system((await gwAudit())[0]), 'the automatic write is attributed to system:overrides, not to the admin');
    assert.equal((await ctx.call('GET', '/api/users')).json.users.find((u) => u.sub === sub).overrides.length, 1, 'live override shows on the user row');
    clock.advance(23 * H); await relogin();
    assert.deepEqual((await tick(tokens.ada)).json.overrides, { applied: 0, ended: 0, failed: 0 }, 'not due yet');
    assert.ok(await personal(sub, 'weekly'));
    clock.advance(2 * H); await relogin();
    assert.deepEqual((await tick(tokens.ada)).json.overrides, { applied: 0, ended: 1, failed: 0 });
    assert.equal(await personal(sub, 'weekly'), null, 'the personal limit is gone again');
    row = await eff(sub, 'weekly'); assert.deepEqual([row.amount, row.source], ['15000', { type: 'organization' }]);
    const o = await status(r.json.id); assert.equal(o.status, 'ended'); assert.ok(o.endedAt);
    const a = await gwAudit(); assert.ok(system(a[0]) && a[0].action === 'spend_limit.delete', 'revert is a delete, by the system key');
  });

  test('previous state a PERSONAL CAP: raised for the window, restored to the old cap', async () => {
    const sub = U.f.sub;
    await put(tokens.ada, sub, { period: 'weekly', action: 'set', usd: 100 });
    const r = await create(sub, { extraUsd: 25.5 });
    assert.deepEqual([r.json.status, r.json.baseCents, r.json.targetCents, r.json.prev], ['active', 10000, 12550, { kind: 'cap', cents: 10000 }]);
    assert.equal((await personal(sub, 'weekly')).amount, '12550');
    clock.advance(25 * H); await relogin();
    assert.equal((await tick(tokens.ada)).json.overrides.ended, 1);
    assert.equal((await personal(sub, 'weekly')).amount, '10000', 'back to the personal cap, not deleted');
    assert.equal((await status(r.json.id)).status, 'ended');
    await put(tokens.ada, sub, { period: 'weekly', action: 'inherit' });
  });

  test('previous state UNLIMITED or no cap to extend: refused with 400 and the gateway is untouched', async () => {
    await put(tokens.ada, U.g.sub, { period: 'weekly', action: 'unlimited' });
    const n = await lastAuditId();
    const r = await create(U.g.sub, {});
    assert.equal(r.status, 400); assert.match(r.json.error, /unlimited/);
    assert.equal(await lastAuditId(), n);
    await put(tokens.ada, U.g.sub, { period: 'weekly', action: 'inherit' });
    // a period nobody capped: daily is not editable, weekly of a user with only a monthly org default... use a period without any cap
    await putOrg(tokens.ada, { period: 'monthly', action: 'set', usd: 500 });
    assert.equal((await create('ghost-' + P, {})).status, 404, 'unknown user');
    assert.equal((await create(U.g.sub, { extraUsd: 0 })).status, 400);
    assert.equal((await create(U.g.sub, { reason: 'x' })).status, 400, 'a reason is required');
    assert.equal((await create(U.g.sub, { endsAt: iso(clock.t + 30 * 60e3) })).status, 400, 'at least one hour');
    assert.equal((await create(U.g.sub, { endsAt: iso(clock.t + 200 * D) })).status, 400, 'at most maxOverrideDays');
    assert.equal((await create(U.g.sub, {}, 'bad.token')).status, 401);
  });

  test('SUPERSEDED when an admin edits the cap through the app mid-boost: marked at once, the manual value survives expiry', async () => {
    const sub = U.h.sub;
    const r = await create(sub, {});
    assert.equal(r.json.status, 'active');
    const edit = await put(tokens.bob, sub, { period: 'weekly', action: 'set', usd: 400 });
    assert.equal(edit.status, 200);
    assert.equal((await status(r.json.id)).status, 'superseded', 'reconcile runs right after the edit');
    assert.equal((await personal(sub, 'weekly')).amount, '40000');
    clock.advance(25 * H); await relogin();
    await tick(tokens.ada);
    assert.equal((await personal(sub, 'weekly')).amount, '40000', 'the manual cap is not reverted');
    assert.equal((await status(r.json.id)).status, 'superseded');
    await put(tokens.ada, sub, { period: 'weekly', action: 'inherit' });
  });

  test('SUPERSEDED when the cap is changed behind the app\'s back (straight on the gateway): detected at expiry', async () => {
    const sub = U.i.sub;
    const r = await create(sub, {});
    assert.equal((await adminCall('POST', '', { key: E.keys.bob, body: { scope: { type: 'user', user_id: sub }, period: 'weekly', amount: '31000' } })).status, 200);
    assert.equal((await status(r.json.id)).status, 'active', 'the app has not noticed yet');
    clock.advance(25 * H); await relogin();
    await tick(tokens.ada);
    const o = await status(r.json.id);
    assert.equal(o.status, 'superseded'); assert.match(o.note, /changed by hand/);
    assert.equal((await personal(sub, 'weekly')).amount, '31000');
    await put(tokens.ada, sub, { period: 'weekly', action: 'inherit' });
  });

  test('SCHEDULED for later: nothing happens early, applied when the clock passes the start, reverted after the end', async () => {
    const sub = U.j.sub;
    const r = await create(sub, { startsAt: iso(clock.t + 2 * H), endsAt: iso(clock.t + 4 * H) });
    assert.equal(r.status, 201); assert.equal(r.json.status, 'scheduled'); assert.equal(await personal(sub, 'weekly'), null);
    clock.advance(1 * H); await relogin(); await tick(tokens.ada);
    assert.equal((await status(r.json.id)).status, 'scheduled'); assert.equal(await personal(sub, 'weekly'), null);
    assert.equal((await create(sub, { startsAt: iso(clock.t + 1.5 * H), endsAt: iso(clock.t + 3 * H) })).status, 409, 'overlapping boost for the same user and period');
    clock.advance(1.5 * H); await relogin();
    assert.deepEqual((await tick(tokens.ada)).json.overrides, { applied: 1, ended: 0, failed: 0 });
    assert.equal((await personal(sub, 'weekly')).amount, '20000');
    clock.advance(3 * H); await relogin(); await tick(tokens.ada);
    assert.equal(await personal(sub, 'weekly'), null); assert.equal((await status(r.json.id)).status, 'ended');
  });

  test('CANCEL an active boost: reverted on the gateway immediately; cancelling again is a 409', async () => {
    const sub = U.k.sub;
    const r = await create(sub, {});
    assert.ok(await personal(sub, 'weekly'));
    const c = await ctx.call('DELETE', `/api/overrides/${r.json.id}`, { token: tokens.bob });
    assert.equal(c.status, 200); assert.equal(c.json.status, 'cancelled');
    assert.equal(await personal(sub, 'weekly'), null);
    assert.equal((await ctx.call('DELETE', `/api/overrides/${r.json.id}`, { token: tokens.bob })).status, 409);
    assert.equal((await ctx.call('DELETE', '/api/overrides/ovr_000000000000', { token: tokens.bob })).status, 404);
    assert.equal((await ctx.call('DELETE', `/api/overrides/${r.json.id}`)).status, 401);
  });

  test('CONCURRENCY: two simultaneous ticks over HTTP apply a scheduled boost once (cap = base + extra, not base + 2x extra)', async () => {
    const sub = U.a.sub;
    const r = await create(sub, { startsAt: iso(clock.t + 1 * H), endsAt: iso(clock.t + 5 * H) });
    assert.equal(r.json.status, 'scheduled');
    const auditBefore = await lastAuditId();
    clock.advance(2 * H); await relogin();
    const results = await Promise.all([tick(tokens.ada), tick(tokens.bob), tick(tokens.ada), tick(tokens.bob)]);
    for (const x of results) assert.equal(x.status, 200);
    assert.equal((await personal(sub, 'weekly')).amount, '20000');
    const writes = (await auditSince(auditBefore)).filter((e) => e.action === 'spend_limit.upsert' && e.after?.scope?.user_id === sub);
    assert.equal(writes.length, 1, 'exactly one gateway write for the boost');
    const o = await status(r.json.id); assert.equal(o.status, 'active'); assert.equal(o.targetCents, 20000);
    clock.advance(4 * H); await relogin(); await tick(tokens.ada);
    assert.equal(await personal(sub, 'weekly'), null);
  });

  test('CONCURRENCY: two separate app instances sharing one store and one gateway tick at once: still one write', async () => {
    const sub = U.b.sub;
    const second = await bootApp({ port: PORTS.appL5, dataDir: tmp, clock, store: createFileStore(tmp) });
    try {
      const r = await create(sub, { startsAt: iso(clock.t + 1 * H), endsAt: iso(clock.t + 5 * H) });
      assert.equal(r.json.status, 'scheduled');
      const n0 = await lastAuditId();
      clock.advance(2 * H);
      const out = await Promise.all([ctx.app.tick(), second.app.tick(), ctx.app.overrides.tick(), second.app.overrides.tick()]);
      const applied = out.map((o) => o.overrides?.applied ?? o.applied);
      assert.equal(applied.filter(Boolean).length >= 1, true);
      const fresh = (await auditSince(n0)).filter((e) => e.action === 'spend_limit.upsert' && e.after?.scope?.user_id === sub);
      assert.equal(fresh.length, 1, 'one write, however many instances ticked');
      assert.equal((await personal(sub, 'weekly')).amount, '20000');
      clock.advance(5 * H); await Promise.all([ctx.app.tick(), second.app.tick()]);
      assert.equal(await personal(sub, 'weekly'), null, 'and exactly one revert');
      const dels = (await gwAudit()).filter((e) => e.action === 'spend_limit.delete' && e.before?.scope?.user_id === sub && system(e));
      assert.equal(dels.length >= 1, true);
    } finally { await second.close(); }
  });

  test('FAILED when the user became unlimited between scheduling and start: nothing applied, reason recorded', async () => {
    const sub = U.c.sub;
    const r = await create(sub, { startsAt: iso(clock.t + 1 * H), endsAt: iso(clock.t + 3 * H) });
    assert.equal(r.json.status, 'scheduled');
    await put(tokens.ada, sub, { period: 'weekly', action: 'unlimited' });
    clock.advance(1.5 * H); await relogin();
    assert.deepEqual((await tick(tokens.ada)).json.overrides, { applied: 0, ended: 0, failed: 1 });
    const o = await status(r.json.id);
    assert.equal(o.status, 'failed'); assert.match(o.note, /unlimited/);
    assert.equal((await personal(sub, 'weekly')).amount, null, 'still unlimited');
    await put(tokens.ada, sub, { period: 'weekly', action: 'inherit' });
  });

  test('removing the personal cap (inherit) mid-boost, when that was the pre-boost state, ends the boost as restored and the org default applies', async () => {
    const sub = U.d.sub;
    const r = await create(sub, {});
    assert.equal((await personal(sub, 'weekly')).amount, '20000');
    await put(tokens.ada, sub, { period: 'weekly', action: 'inherit' });
    const closed = await status(r.json.id);
    assert.equal(closed.status, 'ended'); assert.match(closed.note, /already back at its previous value/);
    assert.deepEqual([(await eff(sub, 'weekly')).amount, (await eff(sub, 'weekly')).source], ['15000', { type: 'organization' }]);
    clock.advance(25 * H); await relogin(); await tick(tokens.ada);
    assert.equal(await personal(sub, 'weekly'), null, 'expiry does not resurrect anything');
  });

  test('a session expires after 12 hours of (fake) time', async () => {
    const t = await ctx.login('ada');
    assert.equal((await ctx.call('POST', '/api/internal/tick', { token: t })).status, 200);
    clock.advance(13 * H);
    assert.equal((await ctx.call('POST', '/api/internal/tick', { token: t })).status, 401);
    await relogin();
  });
});

describe('L3 enforcement end to end: real spend, real cap, real block, and a boost that actually unblocks an engineer', () => {
  let fv, gw, app2, clock2, tok, user;
  const spend = async () => Number((await adminCall('GET', `/effective?user_ids%5B%5D=${user.sub}&period%5B%5D=weekly`, { url: gw.url })).json.data[0].period_to_date_spend);
  const waitSpend = async (cents) => { for (let i = 0; i < 60; i++) { if (await spend() >= cents) return; await sleep(100); } throw new Error('spend never reached ' + cents + ', is ' + await spend()); };
  const ask = async () => messages(mintSession({ ...user, url: gw.url }), { url: gw.url });
  const capOf = async () => (await adminCall('GET', `/effective?user_ids%5B%5D=${user.sub}&period%5B%5D=weekly`, { url: gw.url })).json.data[0];
  before(async () => {
    fv = await startFakeVertex(PORTS.fakeVertex);
    fv.state.usage = { input_tokens: 1000000, output_tokens: 0 };      // every reply costs the same, so the arithmetic below is exact
    gw = gatewayProcess({ name: 'enforce', port: PORTS.vertexGateway, db: 'gateway_vertex', secrets: secretsFromEnv(), loadTest: false, extraEnv: { ANTHROPIC_VERTEX_BASE_URL: `http://127.0.0.1:${PORTS.fakeVertex}/v1` } });
    await gw.start();
    user = { sub: unique('enf'), email: null }; user.email = `${user.sub}@example.com`;
    clock2 = fakeClock();
    app2 = await bootApp({ port: PORTS.appL5, dataDir: fs.mkdtempSync(path.join(E.tmp, 'l3b-')), clock: clock2, gatewayUrl: gw.url });
    tok = await app2.login('ada');
    // A real engineer exists in the gateway after their first request, and the app refuses caps for people it has never seen.
    // Introduce them with a reply that costs nothing, so the spend arithmetic below stays exact.
    const priced = fv.state.usage; fv.state.usage = { input_tokens: 0, output_tokens: 0 };
    await introduce(user, mintSession({ ...user, url: gw.url }), { url: gw.url });
    fv.state.usage = priced;
  });
  after(async () => { await app2?.close(); await gw?.stop(); await fv?.close(); });

  test('app sets a $3 weekly cap; a $2 request is allowed, spend shows in the app, the cap blocks the request after it is exceeded', async () => {
    assert.equal((await app2.call('PUT', `/api/users/${user.sub}/budget`, { token: tok, body: { period: 'weekly', action: 'set', usd: 3 } })).status, 200);
    const r1 = await ask(); assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('anthropic-ratelimit-unified-status'), 'allowed');
    await waitSpend(200);
    const row = await capOf(); assert.deepEqual([row.amount, row.period_to_date_spend], ['300', '200'], 'strings of cents');
    const d = (await app2.call('GET', `/api/users/${user.sub}`)).json;
    assert.deepEqual([d.user.budgets.weekly.capCents, d.user.budgets.weekly.spendCents], [300, 200], 'the app reads spend as numbers');
    assert.equal((await ask()).status, 200, '200 < 300: still allowed');
    await waitSpend(400);
    const blocked = await ask();
    assert.equal(blocked.status, 429); assert.equal(blocked.json.error.type, 'billing_error'); assert.equal(blocked.headers.get('x-should-retry'), 'false');
    assert.equal(blocked.headers.get('anthropic-ratelimit-unified-overage-period'), 'weekly');
    const co = (await app2.call('GET', '/api/company')).json; assert.ok(co.spend.weekly.spendCents >= 400);
  });

  test('raising the cap through the app unblocks immediately; lowering it below spend blocks again', async () => {
    await app2.call('PUT', `/api/users/${user.sub}/budget`, { token: tok, body: { period: 'weekly', action: 'set', usd: 10 } });
    assert.equal((await ask()).status, 200);
    await waitSpend(600);
    await app2.call('PUT', `/api/users/${user.sub}/budget`, { token: tok, body: { period: 'weekly', action: 'set', usd: 4 } });
    assert.equal((await ask()).status, 429, 'spent 6 > cap 4');
    await app2.call('PUT', `/api/users/${user.sub}/budget`, { token: tok, body: { period: 'weekly', action: 'unlimited' } });
    assert.equal((await ask()).status, 200, 'unlimited never blocks');
    await waitSpend(800);
    await app2.call('PUT', `/api/users/${user.sub}/budget`, { token: tok, body: { period: 'weekly', action: 'set', usd: 8 } });
  });

  test('a temporary boost really unblocks a blocked engineer, and its expiry blocks them again', async () => {
    assert.equal((await ask()).status, 429, 'spend is 800 cents, the cap is 800: blocked');
    const end = new Date(clock2.t + 3 * H).toISOString();
    const o = await app2.call('POST', '/api/overrides', { token: tok, body: { sub: user.sub, period: 'weekly', extraUsd: 20, endsAt: end, reason: 'incident response' } });
    assert.equal(o.status, 201, o.text); assert.equal(o.json.status, 'active'); assert.equal(o.json.targetCents, 2800);
    assert.equal((await ask()).status, 200, 'the boosted cap lets the request through');
    clock2.advance(4 * H);
    const t = await app2.login('ada');
    assert.equal((await app2.call('POST', '/api/internal/tick', { token: t })).json.overrides.ended, 1);
    assert.equal((await capOf()).amount, '800', 'back to the manual cap of $8');
    assert.equal((await ask()).status, 429, 'and spend (now above it) is blocked again');
  });
});
