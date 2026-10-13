import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store.mjs';
import { createUsage } from '../lib/usage/index.mjs';

const NOW = Date.UTC(2026, 9, 14, 15, 30);
const END = Math.ceil(NOW / 1000 / 86400) * 86400;
const W = { range: '7d', data: 'all', n: 7, b: 86400, start: END - 7 * 86400, end: END };
const CATALOG = { default: 'sonnet', models: [{ alias: 'sonnet', id: 'claude-sonnet-5-5', tier: 'default' }, { alias: 'opus', id: 'claude-opus-5-5', tier: 'upgrade' }, { alias: 'haiku', id: 'claude-haiku-5-5', tier: 'fast' }] };
const emptyCh = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
const emptyLog = async (url) => (String(url).endsWith('/token') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response(JSON.stringify({ entries: [] })));

const backends = {
  none: () => createUsage({ usageSource: 'none' }, { store: createMemoryStore() }),
  demo: () => createUsage({ usageSource: 'demo', demo: true, catalog: CATALOG }, { store: createMemoryStore(), now: () => NOW }),
  logs: () => createUsage({ usageSource: 'logs', gatewayService: 'claude-gateway' }, { store: createMemoryStore(), fetchImpl: emptyLog, env: { GOOGLE_CLOUD_PROJECT: 'p' } }),
  clickhouse: () => createUsage({ usageSource: 'clickhouse', clickhouse: { url: 'http://127.0.0.1:19151', password: 'pw' } }, { fetchImpl: emptyCh }),
};

function checkShapes({ users, detail, company, roster }, label) {
  assert.ok(roster instanceof Map, label);
  assert.ok(Array.isArray(users.rows) && users.spark instanceof Map, label);
  for (const r of users.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['email', 'lastSeen', 'models', 'ok', 'requests', 'sub'], label);
    assert.ok(r.lastSeen === null || !Number.isNaN(Date.parse(r.lastSeen))); assert.ok(Array.isArray(r.models)); assert.ok(r.ok <= r.requests);
  }
  for (const [, v] of users.spark) { assert.equal(v.length, W.n, label); assert.ok(v.every(Number.isInteger)); }
  assert.deepEqual(Object.keys(detail).sort(), ['models', 'recent', 'series'], label);
  assert.deepEqual(Object.keys(detail.series).sort(), ['models', 'values']);
  for (const m of detail.series.models) assert.equal(detail.series.values[m].length, W.n, label);
  for (const m of detail.models) { assert.deepEqual(Object.keys(m).sort(), ['model', 'ok', 'p50', 'requests']); assert.ok(m.p50 === null || typeof m.p50 === 'number'); }
  for (const r of detail.recent) {
    assert.deepEqual(Object.keys(r).sort(), ['cause', 'email', 'id', 'lt', 'model', 'ms', 'outcome', 'status', 'sub', 'ts'], label);
    assert.ok(['ok', 'spend_cap', 'upstream_error', 'rejected'].includes(r.outcome)); assert.equal(typeof r.lt, 'boolean'); assert.ok(!Number.isNaN(Date.parse(r.ts)));
  }
  assert.deepEqual(Object.keys(company).sort(), ['byModel', 'byUser', 'series', 'totals'], label);
  assert.deepEqual(Object.keys(company.totals).sort(), ['blocked', 'ok', 'rejected', 'requests', 'upstream_errors', 'users'], label);
  for (const u of company.byUser) assert.deepEqual(Object.keys(u).sort(), ['email', 'requests', 'sub']);
  for (const m of company.byModel) assert.deepEqual(Object.keys(m).sort(), ['model', 'ok', 'requests']);
  for (const v of Object.values(company.series)) assert.equal(v.length, W.n, label);
}

for (const [name, make] of Object.entries(backends)) {
  test(`contract shapes: ${name}`, async () => {
    const usage = await make();
    assert.equal(usage.source, name);
    const sub = name === 'demo' ? 'demo-ada' : 'u1';
    checkShapes({ users: await usage.users(W), detail: await usage.detail(sub, W), company: await usage.company(W), roster: await usage.roster() }, name);
    assert.deepEqual(await usage.ingest(), { ingested: 0 });
    const ok = await usage.ok(); assert.equal(ok, name === 'none' ? null : true);
    if (name === 'demo') { const d = await usage.detail(sub, W, 3); assert.equal(d.recent.length, 3); assert.ok(d.models.length > 0); }
  });
}

test('factory: missing source behaves as none, unknown sources throw, a store is optional, extra options reach the backend', async () => {
  assert.equal((await createUsage({})).source, 'none');
  assert.equal(await (await createUsage({ usageSource: 'none' }, {})).ok(), null);
  await assert.rejects(createUsage({ usageSource: 'bogus' }, { store: createMemoryStore() }), /unknown USAGE_SOURCE bogus/);
  const d = await createUsage({ usageSource: 'demo', catalog: CATALOG }, { now: () => NOW }); assert.equal(d.source, 'demo');
  assert.ok((await d.company(W)).totals.requests > 0);
  let called = 0;
  const l = await createUsage({ usageSource: 'logs' }, { store: createMemoryStore(), env: { GOOGLE_CLOUD_PROJECT: 'p' }, fetchImpl: async (...a) => { called++; return emptyLog(...a); } });
  await l.ingest(); assert.ok(called >= 2);
});

test('none never throws and never needs a store, window or network', async () => {
  const u = await createUsage({ usageSource: 'none' }, {});
  assert.deepEqual((await u.company(W)).totals, { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 });
  assert.deepEqual(await u.detail('x', W), { series: { models: [], values: {} }, models: [], recent: [] });
});

test('logs and demo share one store with the aggregator the factory builds (state survives a new usage object)', async () => {
  const store = createMemoryStore();
  const a = await createUsage({ usageSource: 'demo', catalog: CATALOG }, { store, now: () => NOW });
  const b = await createUsage({ usageSource: 'demo', catalog: CATALOG }, { store, now: () => NOW });
  assert.equal((await a.company(W)).totals.requests, (await b.company(W)).totals.requests);
});
