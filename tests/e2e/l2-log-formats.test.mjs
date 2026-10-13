// L2: what the REAL gateway writes to stderr, parsed by the usage backend (api/lib/usage/logs.mjs) and the aggregator.
// Two real gateway processes feed it: the main one (load_test_mode, canned replies) and one with load_test_mode OFF whose
// Vertex upstream is a fake on loopback, which makes the real binary write its genuine "warn vertex upstream ..." error lines.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUsage } from '../../api/lib/usage/index.mjs';
import { createMemoryStore } from '../../api/lib/store.mjs';
import { E } from './lib/env.mjs';
import { PORTS } from './lib/config.mjs';
import { MODELS, adminCall, gatewayProcess, jsonEvents, logSince, logSize, messages, mintSession, resetLimits, secretsFromEnv, sleep, unique, deviceLogin, wget } from './lib/gw.mjs';
import { startFakeVertex } from './lib/fakevertex.mjs';
import { entriesFromLines, fakeCloud, window24h } from './lib/cloudlog.mjs';

const P = unique('l2');
const who = (n) => ({ sub: `${P}-${n}`, email: `${n}-${P}@example.com`, name: n });
const alice = who('alice'), bob = who('bob'), carol = who('carol'), dave = who('dave'), erin = who('erin');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let mainLines = [], vertexLines = [], vertexGw, fakeVertex;
const results = {};     // status codes of every request we sent, by label

before(async () => {
  await resetLimits();
  const off = logSize();
  const send = async (label, user, model, opts = {}) => { const r = await messages(mintSession(user, opts.url), { model, ...opts }); (results[label] ||= []).push(r.status); return r; };
  // --- main gateway (load_test_mode) ---
  for (const m of [MODELS.sonnet, MODELS.sonnet, MODELS.sonnet, MODELS.opus, MODELS.haiku]) await send('alice', alice, m);
  for (const m of [MODELS.sonnet, MODELS.sonnet, 'gpt-4', 'claude-3-opus-20240229']) await send('bob', bob, m);
  await send('carol', carol, MODELS.sonnet);
  const cap = await adminCall('POST', '', { key: E.keys.ada, body: { scope: { type: 'user', user_id: carol.sub }, period: 'weekly', amount: '0' } });
  assert.equal(cap.status, 200);
  await send('carol', carol, MODELS.sonnet);            // blocked by her $0 cap
  results.badToken = [(await messages('not-a-session')).status];
  results.expired = [(await messages(mintSession({ sub: 'x', email: 'x@example.com', ttlSec: -60 }))).status];
  await sleep(300);
  mainLines = logSince(off);
  // --- second gateway, real upstream path against a fake Vertex ---
  fakeVertex = await startFakeVertex(PORTS.fakeVertex);
  vertexGw = gatewayProcess({ name: 'vertex', port: PORTS.vertexGateway, db: 'gateway_vertex', secrets: secretsFromEnv(), loadTest: false, extraEnv: { ANTHROPIC_VERTEX_BASE_URL: `http://127.0.0.1:${PORTS.fakeVertex}/v1` } });
  await vertexGw.start();
  const vend2 = async (label, model) => { const r = await messages(mintSession({ ...erin, url: vertexGw.url }), { model, url: vertexGw.url }); (results[label] ||= []).push(r.status); };
  const vend = async (label, model) => { const r = await messages(mintSession({ ...dave, url: vertexGw.url }), { model, url: vertexGw.url }); (results[label] ||= []).push(r.status); };
  await vend('dave', MODELS.sonnet); await vend('dave', MODELS.opus); await vend('dave', MODELS.haiku); await vend('dave', MODELS.opus);
  // a capped user on the real-upstream gateway: the block must look the same there (minus load_test)
  await vend2('erin', MODELS.sonnet);
  const cap2 = await adminCall('POST', '', { key: E.keys.ada, url: vertexGw.url, body: { scope: { type: 'user', user_id: erin.sub }, period: 'weekly', amount: '0' } });
  assert.equal(cap2.status, 200);
  await vend2('erin', MODELS.sonnet);
  await sleep(300);
  vertexLines = fs.readFileSync(vertexGw.errPath, 'utf8').split('\n').filter(Boolean);
});
after(async () => { await vertexGw?.stop(); await fakeVertex?.close(); await resetLimits(); });

const allLines = () => [...mainLines, ...vertexLines];
async function usageFor(lines, opts = {}) {
  const cloud = fakeCloud(entriesFromLines(lines, opts));
  const store = createMemoryStore();
  const usage = await createUsage({ usageSource: 'logs', gatewayService: 'claude-gateway' }, { store, fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'e2e' } });
  return { usage, cloud, store };
}
const mineOnly = (rows) => rows.filter((r) => r.sub?.includes(P));

describe('L2 what the real gateway emitted', () => {
  test('requests behaved as scripted (statuses)', () => {
    assert.deepEqual(results.alice, [200, 200, 200, 200, 200]);
    assert.deepEqual(results.bob, [200, 200, 400, 400], 'models outside availableModels are refused with 400');
    assert.deepEqual(results.carol, [200, 429], 'a $0 personal cap blocks with 429');
    assert.deepEqual(results.badToken, [401]); assert.deepEqual(results.expired, [401]);
    assert.deepEqual(results.dave, [200, 429, 403, 429], 'fake Vertex: sonnet ok, opus RESOURCE_EXHAUSTED, haiku PERMISSION_DENIED');
    assert.deepEqual(results.erin, [200, 429], 'a $0 cap blocks on the real-upstream gateway too');
  });

  test('every JSON event has the documented envelope; the evt names we parse and the ones we do not', () => {
    const ev = jsonEvents(allLines());
    const inf = ev.filter((e) => e.evt === 'inference');
    for (const e of inf) {
      assert.deepEqual(Object.keys(e).filter((k) => !['load_test'].includes(k)), ['ts', 'evt', 'request_id', 'sub', 'email', 'path', 'model', 'upstream', 'upstream_request_id', 'status', 'ms']);
      assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(e.path, '/v1/messages');
      assert.equal(typeof e.ms, 'number');
    }
    assert.equal(inf.filter((e) => String(e.sub).includes(P)).length, 15, 'alice 5 + bob 4 + carol 1 + dave 4 + erin 1: the blocked and unauthenticated attempts are NOT inference events');
    const names = new Set(ev.map((e) => e.evt));
    for (const n of ['inference', 'auth.denied', 'config.load']) assert.ok(names.has(n), `missing evt ${n}`);
    assert.ok(names.has('spend.blocked'), 'a spend-cap block is logged as evt "spend.blocked"');
    const denied = ev.filter((e) => e.evt === 'auth.denied');
    assert.equal(denied.length >= 2, true); assert.equal(denied[0].reason, 'invalid_token'); assert.equal(denied[0].sub, undefined, 'no identity on denied requests');
  });

  test('load_test marker: canned-reply gateway marks every inference event, the real-upstream one never does', () => {
    const lt = jsonEvents(mainLines).filter((e) => e.evt === 'inference' && String(e.sub).includes(P));
    assert.equal(lt.length, 10); assert.ok(lt.every((e) => e.load_test === true));
    const real = jsonEvents(vertexLines).filter((e) => e.evt === 'inference');
    assert.equal(real.length, 5); assert.ok(real.every((e) => e.load_test === undefined && e.upstream === 'vertex'));
    const blocked = jsonEvents(vertexLines).filter((e) => e.evt === 'spend.blocked');
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0], { ts: blocked[0].ts, evt: 'spend.blocked', request_id: blocked[0].request_id, sub: erin.sub, cause: 'over_limit', cap_cents: '0', source: 'user', period: 'weekly' }, 'same event, no load_test flag, and no inference event follows it');
  });

  test('rejected-by-policy requests are logged with model:null and no upstream (so the dashboard cannot say which model was refused)', () => {
    const rej = jsonEvents(mainLines).filter((e) => e.evt === 'inference' && e.status === 400);
    assert.equal(rej.length, 2);
    for (const e of rej) { assert.equal(e.model, null); assert.equal(e.upstream, null); assert.match(e.email, /^bob-/); }
  });

  test('upstream failures produce BOTH a plain "warn vertex upstream" line and an inference event with the same request_id', () => {
    const textLines = vertexLines.filter((l) => l.includes('warn vertex upstream ') && /request_id=/.test(l));
    assert.equal(textLines.length, 3, 'opus x2 and haiku x1');
    const inf = jsonEvents(vertexLines).filter((e) => e.evt === 'inference' && e.status >= 400);
    for (const e of inf) assert.ok(textLines.some((l) => l.includes('request_id=' + e.request_id + ':')), 'text line for ' + e.request_id);
    assert.ok(textLines.some((l) => /upstream 429 request_id=\S+: 429 \{"error":\{"code":429,.*"status":"RESOURCE_EXHAUSTED"/.test(l)));
    assert.ok(textLines.some((l) => /upstream 403 request_id=\S+: 403 \{"error":\{"code":403,.*"status":"PERMISSION_DENIED"/.test(l)));
  });
});

describe('L2 usage backend over the real lines', () => {
  let usage, w;
  before(async () => {
    ({ usage } = await usageFor(allLines()));
    w = window24h();
  });

  test('ingest() counts exactly the inference events (the noise lines are ignored)', async () => {
    const r = await usage.ingest();
    const wanted = jsonEvents(allLines()).filter((e) => e.evt === 'inference').length;
    assert.equal(r.ingested, wanted);
    assert.ok(wanted >= 15);
  });

  test('users(): counts, ok, models and emails per person', async () => {
    const u = await usage.users(w);
    const by = new Map(mineOnly(u.rows).map((r) => [r.sub, r]));
    assert.equal(by.size, 5, 'alice, bob, carol, dave, erin (the unauthenticated attempts create no user)');
    const a = by.get(alice.sub), b = by.get(bob.sub), c = by.get(carol.sub), d = by.get(dave.sub);
    assert.deepEqual([a.requests, a.ok, a.email], [5, 5, alice.email]);
    assert.deepEqual([...a.models].sort(), [MODELS.haiku, MODELS.opus, MODELS.sonnet]);
    assert.deepEqual([b.requests, b.ok, b.email], [4, 2, bob.email]);
    assert.deepEqual([...b.models], [MODELS.sonnet], 'the refused model is unknown (model:null) so it is not listed');
    assert.deepEqual([c.requests, c.ok], [2, 1], 'carol: one request before her cap, plus the blocked attempt (evt spend.blocked) after it');
    assert.deepEqual([d.requests, d.ok, d.email], [4, 1, dave.email]);
    assert.deepEqual([...d.models].sort(), [MODELS.haiku, MODELS.opus, MODELS.sonnet]);
    for (const r of by.values()) assert.ok(Date.now() - Date.parse(r.lastSeen) < 120e3, 'lastSeen is recent');
    for (const [sub, r] of by) assert.equal(u.spark.get(sub).reduce((x, y) => x + y, 0), r.requests, 'sparkline sums to requests');
  });

  test('company(): totals, outcomes, load-test vs real split', async () => {
    const all = await usage.company(w);
    // other tests may have produced events too, so assert on our users via byUser and on totals as >=
    const mine = mineOnly(all.byUser);
    assert.equal(mine.reduce((s, x) => s + x.requests, 0), 17, '15 inference events plus the 2 spend.blocked attempts');
    assert.ok(all.totals.requests >= 14 && all.totals.ok >= 9);
    const lt = await usage.company({ ...w, data: 'loadtest' }), real = await usage.company({ ...w, data: 'real' });
    assert.equal(mineOnly(lt.byUser).reduce((s, x) => s + x.requests, 0), 11, 'alice+bob+carol are load test (carol\'s blocked attempt included)');
    assert.deepEqual(mineOnly(real.byUser).map((x) => [x.sub, x.requests]).sort(), [[dave.sub, 4], [erin.sub, 2]].sort(), 'dave and erin are real traffic (erin\'s blocked attempt included)');
    assert.equal(lt.totals.blocked, 1, 'carol\'s block is counted'); assert.equal(real.totals.blocked, 1, 'erin\'s block is counted');
    assert.equal(real.totals.upstream_errors, 3); assert.equal(real.totals.ok, 2); assert.equal(real.totals.rejected, 0);
    assert.equal(lt.totals.rejected, 2, 'the two policy 400s');
    assert.equal(lt.totals.upstream_errors, 0);
  });

  test('users(), detail() and company() agree with each other', async () => {
    const u = await usage.users(w), c = await usage.company(w);
    for (const user of [alice, bob, carol, dave]) {
      const row = u.rows.find((r) => r.sub === user.sub), cu = c.byUser.find((x) => x.sub === user.sub), d = await usage.detail(user.sub, w);
      assert.equal(cu.requests, row.requests, user.sub);
      assert.equal(d.models.reduce((s, m) => s + m.requests, 0), row.requests, 'detail model totals = user requests');
      assert.equal(d.models.reduce((s, m) => s + m.ok, 0), row.ok);
      assert.equal(Object.values(d.series.values).flat().reduce((s, x) => s + x, 0), row.requests, 'detail series sums to requests');
      assert.equal(c.series[user.sub].reduce((s, x) => s + x, 0), row.requests, 'company series sums to requests');
    }
    const byModelTotal = c.byModel.reduce((s, m) => s + m.requests, 0);
    assert.equal(byModelTotal, c.totals.requests);
  });

  test('detail(): outcomes, causes, load-test flag, latency', async () => {
    const d = await usage.detail(dave.sub, w, 25);
    assert.equal(d.recent.length, 4);
    const by = (m) => d.recent.filter((r) => r.model === m);
    assert.deepEqual(by(MODELS.sonnet).map((r) => [r.outcome, r.status, r.cause, r.lt]), [['ok', 200, null, false]]);
    assert.deepEqual(by(MODELS.opus).map((r) => [r.outcome, r.status, r.cause]), [['upstream_error', 429, 'RESOURCE_EXHAUSTED'], ['upstream_error', 429, 'RESOURCE_EXHAUSTED']]);
    assert.deepEqual(by(MODELS.haiku).map((r) => [r.outcome, r.status, r.cause]), [['upstream_error', 403, 'PERMISSION_DENIED']]);
    for (const r of d.recent) { assert.equal(r.email, dave.email); assert.equal(r.sub, dave.sub); assert.match(r.id, /^[0-9a-f-]{36}$/); }
    const sonnet = d.models.find((m) => m.model === MODELS.sonnet); assert.equal(sonnet.ok, 1); assert.ok(sonnet.p50 === null || sonnet.p50 >= 0);
    const b = await usage.detail(bob.sub, w, 25);
    const none = b.models.find((m) => m.model === '(none)');
    assert.deepEqual([none.requests, none.ok], [2, 0], 'refused requests are grouped under (none)');
    assert.deepEqual(b.recent.filter((r) => r.outcome === 'rejected').map((r) => [r.status, r.model, r.lt]), [[400, '', true], [400, '', true]]);
    const a = await usage.detail(alice.sub, w); assert.ok(a.recent.every((r) => r.lt === true && r.outcome === 'ok' && r.cause === null));
  });

  test('the same data comes out when JSON lines arrive as text payloads, and in a second ingest()', async () => {
    const { usage: u2 } = await usageFor(allLines(), { jsonAsText: true });
    await u2.ingest();
    const c1 = await usage.company(w), c2 = await u2.company(w);
    assert.deepEqual(c2.totals, c1.totals);
    assert.deepEqual(c2.byUser, c1.byUser);
    assert.equal((await usage.ingest()).ingested, 0, 'a second run over the same entries counts nothing twice');
  });

  test('a cause line that arrives in a LATER ingest still lands on the already-stored request', async () => {
    const lines = vertexLines.filter((l) => !l.includes('warn vertex upstream ') || !/request_id=/.test(l));
    const causes = vertexLines.filter((l) => l.includes('warn vertex upstream ') && /request_id=/.test(l));
    const cloud = fakeCloud(entriesFromLines(lines));
    const u3 = await createUsage({ usageSource: 'logs' }, { store: createMemoryStore(), fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'e2e' } });
    await u3.ingest();
    assert.ok((await u3.detail(dave.sub, w)).recent.filter((r) => r.outcome === 'upstream_error').every((r) => r.cause === null));
    cloud.entries.push(...entriesFromLines(causes));
    await u3.ingest();
    const rec = (await u3.detail(dave.sub, w)).recent.filter((r) => r.outcome === 'upstream_error');
    assert.deepEqual(rec.map((r) => r.cause).sort(), ['PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED']);
  });
});

describe('L2 real upstream-error lines from logs/gateway.log (fixture)', () => {
  test('four recorded upstream failures: outcome, cause, email, model', async () => {
    const lines = fs.readFileSync(path.join(HERE, 'fixtures', 'gateway-sample.log'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 8);
    const NOW = Date.parse('2026-10-12T03:00:00Z');
    const cloud = fakeCloud(entriesFromLines(lines));
    const usage = await createUsage({ usageSource: 'logs' }, { store: createMemoryStore(), fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'e2e' }, now: () => NOW });
    assert.deepEqual(await usage.ingest(), { ingested: 4 });
    const w = window24h(NOW), sub = 'CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs';
    const c = await usage.company(w);
    assert.deepEqual(c.totals, { requests: 4, ok: 0, upstream_errors: 4, blocked: 0, rejected: 0, users: 1 });
    const d = await usage.detail(sub, w, 25);
    const causeOf = Object.fromEntries(d.recent.map((r) => [r.id, [r.cause, r.status, r.email]]));
    assert.deepEqual(causeOf['test-req-001'], ['PERMISSION_DENIED', 403, 'alice@example.com']);
    assert.deepEqual(causeOf['test-req-002'], ['NOT_FOUND', 404, 'alice@example.com']);
    assert.deepEqual(causeOf['test-req-003'], ['RESOURCE_EXHAUSTED', 429, 'alice@example.com']);
    assert.deepEqual(causeOf['2519bbf0-b2e3-42da-a084-ff5f819fa2ba'], ['RESOURCE_EXHAUSTED', 429, 'alice@example.com']);
    assert.deepEqual(d.models.map((m) => m.model).sort(), ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
    assert.ok(d.recent.every((r) => r.outcome === 'upstream_error' && r.lt === false), 'a 429 from the UPSTREAM is an upstream error, not a spend cap');
  });
});

describe('L2 log events from a real login and admin actions', () => {
  test('device login writes session.mint, admin writes write admin.limit.*, a keyless admin call writes admin.denied; none are usage events', async () => {
    const off = logSize();
    const u = who('login');
    await deviceLogin({ sub: u.sub, email: u.email, name: u.name });
    const up = await adminCall('POST', '', { key: E.keys.bob, body: { scope: { type: 'organization' }, period: 'monthly', amount: '12345' } });
    await adminCall('DELETE', '/' + up.json.id, { key: E.keys.bob });
    await fetch(E.gwUrl + '/v1/organizations/spend_limits');
    await sleep(200);
    const ev = jsonEvents(logSince(off));
    const get = (n) => ev.filter((e) => e.evt === n);
    assert.equal(get('device.authorize').length, 1); assert.equal(get('device.verify')[0].result, 'redirect');
    const mint = get('session.mint')[0];
    assert.deepEqual([mint.result, mint.sub, mint.email, mint.ttl_hours], ['success', u.sub, u.email, 1]);
    const upsert = get('admin.limit.upsert')[0], del = get('admin.limit.delete')[0];
    assert.equal(upsert.actor, 'admin-key:bob@example.com'); assert.equal(upsert.scope_type, 'organization'); assert.equal(upsert.amount, '12345');
    assert.equal(del.actor, 'admin-key:bob@example.com'); assert.equal(del.target, up.json.id);
    assert.equal(get('admin.denied')[0].reason, 'no_credentials');
    // none of those are parsed as usage
    const { usage } = await usageFor(logSince(off));
    assert.deepEqual(await usage.ingest(), { ingested: 0 });
    assert.equal(JSON.stringify(logSince(off)).includes(E.keys.bob), false, 'admin keys are never logged');
    assert.equal(JSON.stringify(logSince(off)).includes(E.jwt), false, 'the session secret is never logged');
  });
});

describe('L2 known product bugs', () => {
  test('spend-cap blocks (evt "spend.blocked", no inference event) are counted: company().totals.blocked, detail().recent outcome spend_cap', async () => {
    const { usage } = await usageFor(allLines());
    await usage.ingest();
    const c = await usage.company(window24h());
    const carolRows = (await usage.detail(carol.sub, window24h())).recent;
    assert.equal(carolRows.filter((r) => r.outcome === 'spend_cap').length, 1, 'carol was blocked once; the dashboard shows ' + carolRows.length + ' request(s) and no spend_cap');
    const erinRows = (await usage.detail(erin.sub, window24h())).recent;
    assert.equal(erinRows.filter((r) => r.outcome === 'spend_cap').length, 1, 'same on the real-upstream gateway (erin)');
    assert.ok(c.totals.blocked >= 1, 'totals.blocked stayed ' + c.totals.blocked);
  });
});
