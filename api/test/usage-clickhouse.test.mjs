import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '../lib/usage/clickhouse.mjs';

const CFG = { clickhouse: { url: 'http://127.0.0.1:19150', password: 's3cret-pw' } };
const W = { range: '7d', data: 'all', n: 4, b: 21600, start: 1760000000, end: 1760086400 };
const ALLOWED_LITERALS = new Set(['', '(none)', 'ok', 'upstream_error', 'spend_cap', 'rejected']);

// Fake ClickHouse HTTP: `answer(sql)` returns rows (or a Response). Records every request.
function fake(answer = () => []) {
  const f = { reqs: [] };
  f.fetch = async (url, init) => {
    f.reqs.push({ url: String(url), init, sql: String(init.body) });
    const a = await answer(String(init.body));
    if (a instanceof Response) return a;
    return new Response(JSON.stringify({ data: a }), { status: 200 });
  };
  return f;
}
const literals = (sql) => [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);

test('requests: POST to the otel database, credentials in headers (never in the URL), fixed timeout signal', async () => {
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  await u.company(W);
  assert.ok(f.reqs.length >= 1);
  for (const r of f.reqs) {
    assert.equal(r.init.method, 'POST'); assert.equal(r.url, 'http://127.0.0.1:19150/?database=otel&default_format=JSON');
    assert.ok(!r.url.includes('s3cret-pw')); assert.ok(!r.sql.includes('s3cret-pw'));
    assert.equal(r.init.headers['x-clickhouse-key'], 's3cret-pw'); assert.equal(r.init.headers['x-clickhouse-user'], 'otel'); assert.ok(r.init.signal);
  }
});

test('users: maps rows, builds spark buckets, and only uses window integers in SQL', async () => {
  const f = fake((sql) => sql.includes('AS bi')
    ? [{ sub: 'u1', bi: '0', c: '3' }, { sub: 'u1', bi: 3, c: 2 }, { sub: 'u1', bi: '9', c: '5' }, { sub: 'u1', bi: '-1', c: '5' }, { sub: 'u2', bi: '1', c: '1' }]
    : [{ sub: 'u1', email: 'a@x.io', requests: '5', ok: '4', last_ms: '1760001234567', models: ['m1', 'm2', ''] }, { sub: 'u2', email: '', requests: '1', ok: '0', last_ms: '0', models: 'm1,m2' }]);
  const u = create(CFG, { fetchImpl: f.fetch });
  const r = await u.users({ ...W, data: 'real' });
  assert.deepEqual(r.rows, [
    { sub: 'u1', email: 'a@x.io', requests: 5, ok: 4, lastSeen: new Date(1760001234567).toISOString(), models: ['m1', 'm2'] },
    { sub: 'u2', email: null, requests: 1, ok: 0, lastSeen: null, models: ['m1', 'm2'] },
  ]);
  assert.deepEqual(r.spark.get('u1'), [3, 0, 0, 2], 'out-of-range buckets are dropped'); assert.deepEqual(r.spark.get('u2'), [0, 1, 0, 0]);
  for (const q of f.reqs) {
    assert.match(q.sql, /ts >= toDateTime\(1760000000\) AND ts < toDateTime\(1760086400\)/); assert.match(q.sql, /NOT is_load_test/);
    assert.deepEqual(literals(q.sql).filter((l) => !ALLOWED_LITERALS.has(l)), []);
  }
  assert.match(f.reqs.find((q) => q.sql.includes('AS bi')).sql, /intDiv\(toUnixTimestamp\(ts\) - 1760000000, 21600\)/);
});

test('data filter maps through a fixed table; anything else is refused before any request', async () => {
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  await u.company({ ...W, data: 'loadtest' }); assert.match(f.reqs.at(-1).sql, /AND is_load_test\b/); assert.ok(!/NOT is_load_test/.test(f.reqs.at(-1).sql));
  await u.company({ ...W, data: 'all' }); assert.match(f.reqs.at(-1).sql, /AND 1\b/);
  f.reqs.length = 0;
  for (const data of ['all OR 1=1', "real' --", '__proto__', 'constructor', 'toString', undefined, null, 5]) {
    await assert.rejects(u.company({ ...W, data }), /bad window/, String(data));
  }
  assert.equal(f.reqs.length, 0);
});

test('window numbers must be integers; nothing else reaches SQL', async () => {
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  for (const bad of [{ start: '1; DROP TABLE x' }, { start: 1.5 }, { end: NaN }, { n: Infinity }, { b: '3600' }, { n: 0 }, { b: 0 }, { n: 99999 }, { end: W.start }, { start: -1 }, { start: null }]) {
    await assert.rejects(u.users({ ...W, ...bad }), /bad window/, JSON.stringify(bad));
    await assert.rejects(u.detail('ok-user', { ...W, ...bad }), /bad window/);
    await assert.rejects(u.company({ ...W, ...bad }), /bad window/);
  }
  await assert.rejects(u.users(null), /bad window/);
  assert.equal(f.reqs.length, 0);
});

test('detail: hostile sub values are rejected without touching the database', async () => {
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  const bad = ["x' OR 1=1 --", "x'; DROP TABLE otel.otel_logs; --", 'a b', 'a\nb', 'a"b', 'a\\', "a'", '', 'x'.repeat(201), 'ü', '../etc', 'a%27', null, undefined, 5, { toString: () => 'ok' }, ['ok']];
  for (const sub of bad) await assert.rejects(u.detail(sub, W), /bad user id/, JSON.stringify(sub));
  assert.equal(f.reqs.length, 0);
});

test('detail: valid subs (base64url-ish gateway ids) appear only as the one quoted literal', async () => {
  const sub = 'CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs';
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  await u.detail(sub, W, '5; DROP TABLE x');
  assert.equal(f.reqs.length, 3);
  for (const q of f.reqs) {
    assert.ok(q.sql.includes(`'${sub}'`)); assert.deepEqual(literals(q.sql).filter((l) => !ALLOWED_LITERALS.has(l) && l !== sub), []);
    assert.ok(!/DROP/.test(q.sql));
  }
  assert.match(f.reqs.find((q) => q.sql.includes('LIMIT')).sql, /LIMIT 25$/, 'a non-integer limit falls back to 25');
  await u.detail('ab-_9', W, 9999); assert.match(f.reqs.at(-1).sql, /LIMIT 500$/, 'limit is capped');
  await u.detail('ab-_9', W, 0); assert.match(f.reqs.at(-1).sql, /LIMIT 1$/);
  await u.detail('ab-_9', { ...W, data: 'real' }); assert.match(f.reqs.at(-1).sql, /AND NOT r\.is_load_test/, 'the join query qualifies its columns');
});

test('detail: maps series, per-model p50, and recent requests into the contract shapes', async () => {
  const f = fake((sql) => {
    if (sql.includes('AS bi')) return [{ bi: '0', model: 'm1', c: '4' }, { bi: '2', model: 'm1', c: '1' }, { bi: '1', model: '(none)', c: '2' }, { bi: '77', model: 'm1', c: '9' }];
    if (sql.includes('quantileIf')) return [{ model: 'm1', requests: '5', ok: '4', p50: '812' }, { model: '(none)', requests: '2', ok: '0', p50: '0' }];
    return [{ ts_ms: '1760001000000', id: 'r1', sub: 'u1', email: 'a@x.io', model: 'm1', outcome: 'upstream_error', status: '429', ms: '200', lt: 0, cause: 'RESOURCE_EXHAUSTED' },
            { ts_ms: '1760000000000', id: 'r2', sub: 'u1', email: '', model: '(none)', outcome: 'rejected', status: 400, ms: '8', lt: true, cause: '' }];
  });
  const d = await create(CFG, { fetchImpl: f.fetch }).detail('u1', W);
  assert.deepEqual(d.series, { models: ['m1', '(none)'], values: { m1: [4, 0, 1, 0], '(none)': [0, 2, 0, 0] } });
  assert.deepEqual(d.models, [{ model: 'm1', requests: 5, ok: 4, p50: 812 }, { model: '(none)', requests: 2, ok: 0, p50: null }]);
  assert.deepEqual(d.recent[0], { ts: new Date(1760001000000).toISOString(), id: 'r1', sub: 'u1', email: 'a@x.io', model: 'm1', outcome: 'upstream_error', status: 429, ms: 200, lt: false, cause: 'RESOURCE_EXHAUSTED' });
  assert.deepEqual(d.recent[1], { ts: new Date(1760000000000).toISOString(), id: 'r2', sub: 'u1', email: '', model: '(none)', outcome: 'rejected', status: 400, ms: 8, lt: true, cause: null });
});

test('company and roster: map totals, users, models and per-user series', async () => {
  const f = fake((sql) => {
    if (sql.includes('uniqExactIf')) return [{ requests: '10', ok: '7', upstream_errors: '1', blocked: '1', rejected: '1', users: '2' }];
    if (sql.includes('GROUP BY bi, sub')) return [{ bi: '0', sub: 'u1', c: '3' }, { bi: '3', sub: 'u2', c: '2' }, { bi: '8', sub: 'u2', c: '2' }];
    if (sql.includes('GROUP BY sub ORDER')) return [{ sub: 'u1', email: 'a@x.io', c: '6' }, { sub: 'u2', email: '', c: '4' }];
    if (sql.includes('GROUP BY model')) return [{ model: 'm1', requests: '8', ok: '6' }, { model: '(none)', requests: '2', ok: '0' }];
    return [{ sub: 'u1', email: 'a@x.io' }, { sub: 'u2', email: '' }];
  });
  const u = create(CFG, { fetchImpl: f.fetch });
  assert.deepEqual(await u.company(W), {
    totals: { requests: 10, ok: 7, upstream_errors: 1, blocked: 1, rejected: 1, users: 2 },
    byUser: [{ sub: 'u1', email: 'a@x.io', requests: 6 }, { sub: 'u2', email: null, requests: 4 }],
    byModel: [{ model: 'm1', requests: 8, ok: 6 }, { model: '(none)', requests: 2, ok: 0 }],
    series: { u1: [3, 0, 0, 0], u2: [0, 0, 0, 2] },
  });
  assert.deepEqual([...(await u.roster())], [['u1', 'a@x.io'], ['u2', null]]);
});

test('empty database answers give the empty shapes', async () => {
  const u = create(CFG, { fetchImpl: fake().fetch });
  assert.deepEqual((await u.company(W)).totals, { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 });
  assert.deepEqual(await u.detail('u1', W), { series: { models: [], values: {} }, models: [], recent: [] });
  const us = await u.users(W); assert.deepEqual(us.rows, []); assert.equal(us.spark.size, 0);
});

test('ok(): SELECT 1; false on any failure; null when no password is configured; ingest is a no-op', async () => {
  const f = fake(); const u = create(CFG, { fetchImpl: f.fetch });
  assert.equal(await u.ok(), true); assert.equal(f.reqs[0].sql, 'SELECT 1');
  assert.equal(await create(CFG, { fetchImpl: async () => new Response('down', { status: 503 }) }).ok(), false);
  assert.equal(await create(CFG, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }).ok(), false);
  const none = fake(); const n = create({ clickhouse: { url: 'http://x', password: '' } }, { fetchImpl: none.fetch });
  assert.equal(await n.ok(), null); assert.deepEqual((await n.company(W)).byUser, []); assert.equal(none.reqs.length, 0);
  assert.deepEqual(await u.ingest(), { ingested: 0 }); assert.equal(u.source, 'clickhouse');
});

test('errors: a failing store raises a 502-tagged error that never contains the password', async () => {
  const u = create(CFG, { fetchImpl: async () => new Response('Code: 516. Authentication failed for user otel', { status: 500 }) });
  await assert.rejects(u.company(W), (e) => e.status === 502 && /usage store error 500/.test(e.message) && !e.message.includes('s3cret-pw'));
  const bad = create(CFG, { fetchImpl: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(bad.roster(), (e) => e.status === 502 && /invalid JSON/.test(e.message));
});
