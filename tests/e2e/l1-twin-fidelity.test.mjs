// L1: the in-memory twin (createMemoryGateway, used by demo mode and by every api unit test) against the REAL gateway
// (createHttpGateway + real per-admin write keys). Same scenario, same observable results after normalising ids and timestamps.
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpGateway, createMemoryGateway } from '../../api/lib/gateway.mjs';
import { E } from './lib/env.mjs';
import { adminCall, introduce, mintSession, resetLimits, unique, wget } from './lib/gw.mjs';
import { normaliser } from './lib/norm.mjs';

const P = unique('l1');
const users = ['a', 'b', 'c'].map((n) => ({ sub: `${P}-${n}`, email: `${P}-${n}@example.com`, name: `${P} ${n}` }));
const SUBS = users.map((u) => u.sub);
const ADA = { key: E.keys.ada, actor: 'ada@example.com' }, BOB = { key: E.keys.bob, actor: 'bob@example.com' }, SYS = { key: E.keys.system, actor: 'system:overrides' };
const real = createHttpGateway({ gatewayUrl: E.gwUrl, readKey: E.keys.read, gatewayAudience: '' });
const org = { type: 'organization' }, user = (u) => ({ type: 'user', user_id: u.sub });
const mine = (rows) => rows.filter((r) => String(r.scope?.user_id).startsWith(P));
const cap = (rows, sub, period) => rows.find((r) => r.scope.user_id === sub && r.period === period);
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: { status: e.status, name: e.constructor.name } }; } };

before(async () => {
  await resetLimits();
  for (const u of users) await introduce(u, mintSession(u));
});

// Runs the identical script against one gateway and returns every observable result, in order.
async function scenario(gw, label) {
  const n = normaliser(), steps = [];
  n.setAuditBase(Number((await gw.audit(1))[0]?.id || 0) + 1);   // audit ids are a global counter on the real gateway
  const view = async (what) => steps.push({
    what, limits: n.any((await gw.listLimits()).sort((a, b) => (a.period + a.scope.type + (a.scope.user_id || '')).localeCompare(b.period + b.scope.type + (b.scope.user_id || '')))),
    effective: n.any(await gw.effective(SUBS)), effectiveAll: n.any(mine(await gw.effectiveAll())), audit: n.audit(await gw.audit(200)).filter((e) => JSON.stringify(e).includes(P) || (e.after || e.before)?.scope?.type === 'organization'),
  });
  const step = async (what, fn) => { const r = await attempt(fn); steps.push({ what, result: r.err ? r : { ok: n.any(r.ok) } }); return r.ok; };
  await view('empty');
  await step('org default weekly 150', () => gw.upsert(org, 'weekly', 15000, ADA));
  await step('org default monthly 500', () => gw.upsert(org, 'monthly', 50000, ADA));
  await view('org defaults only');
  const p1 = await step('personal weekly a=200 (bob)', () => gw.upsert(user(users[0]), 'weekly', 20000, BOB));
  await step('unlimited weekly b (ada)', () => gw.upsert(user(users[1]), 'weekly', null, ADA));
  await step('personal daily c=10 (ada)', () => gw.upsert(user(users[2]), 'daily', 1000, ADA));
  await view('personal, unlimited, daily');
  await step('edit a weekly to 300 (ada)', () => gw.upsert(user(users[0]), 'weekly', 30000, ADA));
  await step('edit org weekly to 175 (system)', () => gw.upsert(org, 'weekly', 17500, SYS));
  await step('zero cap for c monthly', () => gw.upsert(user(users[2]), 'monthly', 0, BOB));
  await view('after edits');
  await step('delete a weekly (bob)', () => gw.remove(p1.id, BOB));
  await step('delete unknown limit', () => gw.remove('spl_00000000000000000000000000000000', ADA));
  await step('delete same limit twice', () => gw.remove(p1.id, BOB));
  await view('after deletes');
  await step('effective for unknown user', async () => n.any(await gw.effective(['nobody-' + P])));
  await step('effective for nobody', async () => gw.effective([]));
  return steps;
}

describe('L1 twin fidelity', () => {
  let a, b;
  before(async () => {
    a = await scenario(real, 'real');
    await resetLimits();
    // the twin starts empty too; its clock is real time so timestamps are comparable shapes
    b = await scenario(createMemoryGateway({ users }), 'twin');
  });

  const stepNames = ['empty', 'org defaults only', 'personal, unlimited, daily', 'after edits', 'after deletes'];
  for (const name of stepNames) {
    test(`views match field-for-field: ${name}`, () => {
      const x = a.find((s) => s.what === name), y = b.find((s) => s.what === name);
      assert.deepEqual(y.limits, x.limits, 'listLimits');
      assert.deepEqual(y.effective, x.effective, 'effective(subs)');
      assert.deepEqual(y.effectiveAll, x.effectiveAll, 'effectiveAll');
      assert.deepEqual(y.audit, x.audit, 'audit');
    });
  }

  test('write results match (upsert/remove return values and error statuses), ignoring the known `type` gap below', () => {
    const strip = (r) => (r.ok && typeof r.ok === 'object' && !Array.isArray(r.ok) ? { ok: Object.fromEntries(Object.entries(r.ok).filter(([k]) => k !== 'type')) } : r);
    for (const x of a.filter((s) => s.result && s.what !== 'delete a weekly (bob)')) assert.deepEqual(strip(b.find((s) => s.what === x.what).result), strip(x.result), x.what);
    assert.deepEqual(a.find((s) => s.what === 'delete a weekly (bob)').result, { ok: { type: 'spend_limit_deleted', id: 'LIMIT#3' } }, 'real DELETE answers {type:spend_limit_deleted,id}; the twin answers the same since the twin fix');
    assert.deepEqual(a.find((s) => s.what === 'delete unknown limit').result, { err: { status: 404, name: 'HttpError' } });
    assert.deepEqual(a.find((s) => s.what === 'delete same limit twice').result, { err: { status: 404, name: 'HttpError' } });
    assert.deepEqual(a.find((s) => s.what === 'effective for nobody').result, { ok: [] });
  });

  test('effective(): cap/source/spend_limit_id semantics for the three states', async () => {
    const rows = a.find((s) => s.what === 'after deletes').effective;
    // after the scenario: org weekly 175 (system), org monthly 500; a has no personal weekly (deleted), b unlimited weekly, c daily 10 + monthly 0
    const aw = cap(rows, SUBS[0], 'weekly'), bw = cap(rows, SUBS[1], 'weekly'), cd = cap(rows, SUBS[2], 'daily'), cm = cap(rows, SUBS[2], 'monthly'), bd = cap(rows, SUBS[1], 'daily');
    assert.deepEqual([aw.amount, aw.source], ['17500', { type: 'organization' }], 'inherits the org default');
    assert.deepEqual([bw.amount, bw.source?.type], [null, 'user'], 'unlimited: amount null but source is the user (so the UI can tell it from "no cap")');
    assert.match(bw.spend_limit_id, /^LIMIT#/, 'an unlimited row still points at its limit');
    assert.deepEqual([bd.amount, bd.source, bd.spend_limit_id], [null, null, null], 'no limit at all: everything null');
    assert.equal(cd.amount, '1000'); assert.equal(cm.amount, '0', 'a zero cap is a cap, not "none"');
    for (const r of rows) assert.equal(r.period_to_date_spend, '0', 'canned load-test replies cost nothing');
  });

  test('audit trail: actor attribution per admin key, action names, before/after snapshots', async () => {
    const ev = a.find((s) => s.what === 'after deletes').audit;
    const by = (actor) => ev.filter((e) => e.actor === actor).length;
    assert.ok(by('admin-key:ada@example.com') === 5 && by('admin-key:bob@example.com') === 3 && by('admin-key:system:overrides') === 1, JSON.stringify(ev.map((e) => e.actor)));
    assert.deepEqual([...new Set(ev.map((e) => e.action))].sort(), ['spend_limit.delete', 'spend_limit.upsert']);
    const edit = ev.find((e) => e.action === 'spend_limit.upsert' && e.before?.amount === '20000');
    assert.equal(edit.after.amount, '30000'); assert.equal(edit.actor, 'admin-key:ada@example.com'); assert.equal(edit.target_id, edit.after.id);
    const created = ev.find((e) => e.action === 'spend_limit.upsert' && e.before === null && e.after.scope.user_id === SUBS[1]);
    assert.equal(created.after.amount, null, 'unlimited is recorded as a null amount');
    const del = ev.find((e) => e.action === 'spend_limit.delete');
    assert.equal(del.after, null); assert.equal(del.before.amount, '30000');
    assert.ok(ev.every((e, i) => i === 0 || Number(ev[i - 1].id) > Number(e.id)), 'newest first');
  });
});

describe('L1 write protection and validation on the real gateway', () => {
  test('a read key cannot write: raw 403, and the client reports it as a 502 without echoing the key', async () => {
    const body = { scope: org, period: 'weekly', amount: '100' };
    assert.equal((await adminCall('POST', '', { key: E.keys.read, body })).status, 403);
    assert.equal((await adminCall('DELETE', '/spl_x', { key: E.keys.read })).status, 403);
    const r = await attempt(() => real.upsert(org, 'weekly', 100, { key: E.keys.read, actor: 'x' }));
    assert.deepEqual(r.err, { status: 502, name: 'HttpError' });
    const e = await real.upsert(org, 'weekly', 100, { key: E.keys.read, actor: 'x' }).catch((x) => x);
    assert.ok(!String(e.message).includes(E.keys.read));
    assert.equal((await real.listLimits()).filter((l) => l.scope.type === 'organization' && l.amount === '100').length, 0, 'nothing was written');
  });
  test('unknown, missing and wrong keys: 401 from the gateway, client says 502', async () => {
    assert.equal((await adminCall('GET', '', { key: 'f'.repeat(48) })).status, 401);
    const bad = createHttpGateway({ gatewayUrl: E.gwUrl, readKey: 'f'.repeat(48), gatewayAudience: '' });
    assert.equal((await attempt(() => bad.listLimits())).err.status, 502);
    assert.equal((await attempt(() => real.upsert(org, 'weekly', 1, { key: 'f'.repeat(48), actor: 'x' }))).err.status, 502);
  });
  test('invalid amounts and periods are rejected with 400 (what the app already screens for)', async () => {
    for (const amount of ['-5', '1.5', 'abc', '', '1e3', ' 5']) {
      const r = await adminCall('POST', '', { key: E.keys.ada, body: { scope: org, period: 'weekly', amount } });
      assert.equal(r.status, 400, `amount ${JSON.stringify(amount)} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    assert.equal((await adminCall('POST', '', { key: E.keys.ada, body: { scope: org, period: 'yearly', amount: '5' } })).status, 400);
    assert.equal((await adminCall('POST', '', { key: E.keys.ada, body: { scope: { type: 'planet' }, period: 'weekly', amount: '5' } })).status, 400);
    assert.equal((await adminCall('POST', '', { key: E.keys.ada, body: { scope: { type: 'user' }, period: 'weekly', amount: '5' } })).status, 400, 'user scope needs user_id');
    assert.equal((await attempt(() => real.upsert(org, 'weekly', -5, ADA))).err.status, 400);
    assert.equal((await attempt(() => real.remove('spl_nope', ADA))).err.status, 404);
  });
  test('huge amounts: what the gateway accepts bounds what the app must screen for', async () => {
    const r = await adminCall('POST', '', { key: E.keys.ada, body: { scope: user({ sub: P + '-huge' }), period: 'monthly', amount: '99999999999999999999' } });
    assert.ok([200, 400].includes(r.status), String(r.status));
    if (r.status === 200) await adminCall('DELETE', '/' + r.json.id, { key: E.keys.ada });
  });
});

describe('L1 twin divergences (fixed: the twin now rejects/returns what the real gateway does)', () => {
  test('twin rejects amounts and periods the real gateway rejects with 400', async () => {
    const twin = createMemoryGateway({ users });
    const bad = await attempt(() => twin.upsert(org, 'weekly', -5, ADA));
    const badPeriod = await attempt(() => twin.upsert(org, 'yearly', 5, ADA));
    assert.equal(bad.err?.status, 400, 'twin stored a negative cap');
    assert.equal(badPeriod.err?.status, 400, 'twin stored period "yearly"');
  });
  test('twin with a `keys` map refuses a read-only key for writes (real gateway: 403, the client says 502); without one it stays permissive for demo mode', async () => {
    const twin = createMemoryGateway({ users, keys: { 'READ-ONLY-KEY': 'read', 'WRITE-KEY': 'write' } });
    const r = await attempt(() => twin.upsert(org, 'weekly', 100, { key: 'READ-ONLY-KEY', actor: 'x' }));
    assert.deepEqual(r.err, { status: 502, name: 'HttpError' }, 'twin accepted a write with a read key');
    assert.ok((await attempt(() => twin.upsert(org, 'weekly', 100, { key: 'WRITE-KEY', actor: 'x' }))).ok);
    assert.ok((await attempt(() => createMemoryGateway({ users }).upsert(org, 'weekly', 100, { key: 'anything', actor: 'x' }))).ok);
  });
  test('remove() of the twin resolves undefined, the real client resolves the gateway body {id}', async () => {
    const twin = createMemoryGateway({ users });
    const t = await twin.upsert(org, 'monthly', 1, ADA), r = await real.upsert(org, 'monthly', 1, ADA);
    assert.deepEqual(Object.keys(await twin.remove(t.id, ADA) ?? {}), Object.keys(await real.remove(r.id, ADA) ?? {}));
  });
  test('upsert() result of the twin lacks type:"spend_limit"', async () => {
    const twin = createMemoryGateway({ users });
    const t = await twin.upsert(org, 'weekly', 100, ADA);
    const r = await real.upsert(org, 'weekly', 100, ADA);
    assert.deepEqual(Object.keys(t).sort(), Object.keys(r).sort(), 'upsert result keys');
    await real.remove(r.id, ADA);
  });
});

describe('L1 pagination and batching: the assumptions inside createHttpGateway, checked against the real wire format', () => {
  const PERIODS = ['daily', 'weekly', 'monthly'];
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } })); };

  test('GET spend_limits?limit=N: {data, has_more, first_id, last_id} and after_id walks every row exactly once', async () => {
    await resetLimits();
    const made = [];
    for (let i = 0; i < 5; i++) made.push((await real.upsert(user({ sub: `${P}-pg${i}` }), 'weekly', 100 + i, ADA)).id);
    const first = await adminCall('GET', '?limit=2');
    assert.deepEqual(Object.keys(first.json).sort(), ['data', 'first_id', 'has_more', 'last_id']);
    assert.equal(first.json.data.length, 2); assert.equal(first.json.has_more, true); assert.equal(first.json.last_id, first.json.data[1].id);
    const seen = [];
    let url = '?limit=2';
    for (let i = 0; i < 10; i++) {
      const j = (await adminCall('GET', url)).json; seen.push(...j.data.map((l) => l.id));
      if (!j.has_more) break;
      url = `?limit=2&after_id=${j.last_id}`;
    }
    assert.deepEqual([...seen].sort(), [...made].sort(), 'every limit once, none twice, none missing');
    assert.equal((await real.listLimits()).length, 5);
  });

  test('GET /effective?limit=N: next_page cursor (the client passes it back as &page=) walks every row once', async () => {
    const q = PERIODS.map((p) => 'period%5B%5D=' + p).join('&');
    const all = (await adminCall('GET', '/effective?' + q + '&limit=1000')).json;
    assert.equal(all.next_page, null);
    const mineAll = all.data.filter((r) => String(r.scope.user_id).startsWith(P));
    assert.ok(mineAll.length >= 9, 'rows exist for the three introduced users, got ' + mineAll.length + ' of ' + all.data.length + ': ' + JSON.stringify(all.data.map((r) => r.scope.user_id + r.period)).slice(0, 400));
    const seen = []; let page = '';
    for (let i = 0; i < 100; i++) {
      const j = (await adminCall('GET', '/effective?' + q + '&limit=2' + page)).json;
      assert.ok(new Set(j.data.map((r) => r.scope.user_id)).size <= 2, 'limit counts users (3 period rows each), not rows'); seen.push(...j.data.map((r) => `${r.scope.user_id}|${r.period}`));
      if (!j.next_page) break;
      page = '&page=' + encodeURIComponent(j.next_page);
    }
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
    assert.equal(seen.length, all.data.length, 'same total as one big page');
  });

  test('effective(subs) with 120 subs is split into batches of 50 and returns 3 rows per sub, unknown subs included', async () => {
    const subs = Array.from({ length: 120 }, (_, i) => `${P}-batch${i}`);
    const rows = await real.effective(subs);
    assert.equal(rows.length, 360);
    assert.equal(new Set(rows.map((r) => r.scope.user_id)).size, 120);
    for (const sub of subs.slice(0, 120)) assert.deepEqual(rows.filter((r) => r.scope.user_id === sub).map((r) => r.period).sort(), ['daily', 'monthly', 'weekly']);
    assert.ok(rows.every((r) => r.actor.name === null && r.actor.email_address === null), 'unknown users have no name/email');
  });

  test('listLimits() follows has_more across more than one page of 1000 limits (1101 limits)', async () => {
    await resetLimits();
    const jobs = [];
    for (let i = 0; i < 367; i++) for (const period of PERIODS) jobs.push({ sub: `${P}-bulk${i}`, period });
    const t0 = Date.now();
    await pool(jobs, 25, (j) => real.upsert(user({ sub: j.sub }), j.period, 500, ADA));
    const made = Date.now() - t0;
    const rows = await real.listLimits();
    assert.equal(rows.length, 1101);
    assert.equal(new Set(rows.map((r) => r.id)).size, 1101, 'no duplicates at the page boundary');
    console.log(`  (created 1101 limits in ${made} ms, listed in ${Date.now() - t0 - made} ms)`);
    const a500 = await adminCall('GET', '/audit?limit=500');
    assert.equal(a500.status, 200); assert.equal(a500.json.data.length, 500); assert.equal(a500.json.has_more, true, 'the app shows at most 500 audit events and never pages: older ones are not reachable');
    assert.equal((await real.audit(500)).length, 500);
    await resetLimits();
    assert.equal((await real.listLimits()).length, 0);
  });
});
