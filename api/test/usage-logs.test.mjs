import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store.mjs';
import { createAggregator } from '../lib/usage/aggregate.mjs';
import { create, parseEntry, canonTs } from '../lib/usage/logs.mjs';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY0 = Math.floor(NOW / 86400e3) * 86400;
const W = { range: '7d', data: 'all', n: 7, b: 86400, start: DAY0 - 6 * 86400, end: DAY0 + 86400 };
const CFG = { gatewayService: 'claude-gateway' };

// ---- fixtures ----
const inf = (o = {}) => ({ ts: '2026-10-12T10:00:00.123Z', evt: 'inference', request_id: 'r-1', sub: 'u1', email: 'a@example.com', path: '/v1/messages', model: 'claude-sonnet-5-5', upstream: 'vertex', upstream_request_id: null, status: 200, ms: 321, ...o });
const errText = (id, status = 'RESOURCE_EXHAUSTED', code = 429) => `[gateway] 2026-10-12T10:00:00.100Z warn vertex upstream ${code} request_id=${id}: ${code} {"error":{"code":${code},"message":"Quota exceeded for aiplatform.googleapis.com","status":"${status}"}}`;
let seq = 0;
const jEntry = (ts, payload, insertId) => ({ insertId: insertId || `i${++seq}`, timestamp: ts, jsonPayload: payload, resource: { type: 'cloud_run_revision' } });
const tEntry = (ts, text, insertId) => ({ insertId: insertId || `i${++seq}`, timestamp: ts, textPayload: text });

// ---- a tiny fake of the Cloud Logging + metadata endpoints ----
function fakeCloud({ entries = [], pageSize = 1000, project = 'proj-1', expires = 3600 } = {}) {
  const f = { entries, calls: [], tokens: 0, fail: null, failAt: null, expires, rejectFirstToken: false, project };
  f.fetch = async (url, init = {}) => {
    f.calls.push({ url: String(url), init });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/service-accounts/default/token')) { assert.equal(init.headers['metadata-flavor'], 'Google'); f.tokens++; return json(200, { access_token: 'tok-' + f.tokens, expires_in: f.expires }); }
    if (String(url).endsWith('/project/project-id')) return new Response(f.project);
    assert.equal(String(url), 'https://logging.googleapis.com/v2/entries:list');
    const body = JSON.parse(init.body); f.lastBody = body; f.bodies = [...(f.bodies || []), body];
    const n = f.calls.filter((c) => c.url.includes('entries:list')).length;
    if (f.rejectFirstToken && init.headers.authorization === 'Bearer tok-1') return json(401, { error: { message: 'expired' } });
    if (f.fail === 'hang') return new Promise((_, rej) => { const keep = setTimeout(() => {}, 5000); init.signal.addEventListener('abort', () => { clearTimeout(keep); rej(init.signal.reason); }); });   // AbortSignal.timeout timers are unref'd
    if (f.fail || (f.failAt === n)) { const s = f.fail || f.failIs || 500; return json(s, { error: { message: 'boom ' + s } }); }
    const from = /timestamp>="([^"]+)"/.exec(body.filter)[1];
    const rows = f.entries.filter((e) => canonTs(e.timestamp) >= from).sort((a, b) => (canonTs(a.timestamp) < canonTs(b.timestamp) ? -1 : canonTs(a.timestamp) > canonTs(b.timestamp) ? 1 : 0));
    const start = body.pageToken ? Number(body.pageToken) : 0;
    const out = rows.slice(start, start + pageSize);
    return json(200, { entries: out, ...(start + pageSize < rows.length ? { nextPageToken: String(start + pageSize) } : {}) });
  };
  return f;
}
function setup(entries, opts = {}, cfg = CFG) {
  const store = createMemoryStore(), aggregator = createAggregator(store, { now: () => NOW });
  const cloud = fakeCloud({ entries, ...opts.cloud });
  const usage = create(cfg, { store, aggregator, fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'proj-1', ...(opts.env || {}) }, now: () => opts.nowRef?.v ?? NOW, ...(opts.create || {}) });
  return { store, aggregator, cloud, usage };
}
const total = async (usage, data = 'all') => (await usage.company({ ...W, data })).totals;

// ---- parsing ----
test('canonTs pads fractions and rejects non-UTC garbage', () => {
  assert.equal(canonTs('2026-10-12T10:00:00Z'), '2026-10-12T10:00:00.000000000Z');
  assert.equal(canonTs('2026-10-12T10:00:00.5Z'), '2026-10-12T10:00:00.500000000Z');
  assert.equal(canonTs('2026-10-12T10:00:00.123456789Z'), '2026-10-12T10:00:00.123456789Z');
  for (const bad of ['', null, undefined, 'yesterday', '2026-13-45T10:00:00Z', '2026-10-12T10:00:00+02:00']) assert.equal(canonTs(bad), null);
});

test('parseEntry: inference JSON becomes an event with the gateway fields mapped', () => {
  const p = parseEntry(jEntry('2026-10-12T10:00:00.200Z', inf({ load_test: true, status: 429, upstream: '' })));
  assert.deepEqual(p.event, { ts: Date.parse('2026-10-12T10:00:00.123Z'), requestId: 'r-1', sub: 'u1', email: 'a@example.com', model: 'claude-sonnet-5-5', status: 429, ms: 321, upstream: '', loadTest: true });
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ upstream: null }))).event.upstream, '', 'null upstream means no provider was involved');
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ load_test: 'true' }))).event.loadTest, true);
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ load_test: undefined }))).event.loadTest, false);
  const noTs = parseEntry(jEntry('2026-10-12T10:00:05Z', inf({ ts: undefined }))).event;
  assert.equal(noTs.ts, Date.parse('2026-10-12T10:00:05Z'), 'falls back to the log entry time');
  const asText = parseEntry(tEntry('2026-10-12T10:00:00Z', JSON.stringify(inf())));
  assert.equal(asText.event.requestId, 'r-1', 'a JSON line that was not auto-parsed still works');
});

test('parseEntry: upstream error text lines give a cause; malformed, truncated and foreign lines are skipped', () => {
  assert.deepEqual(parseEntry(tEntry('2026-10-12T10:00:00Z', errText('r-9'))), { cause: { requestId: 'r-9', cause: 'RESOURCE_EXHAUSTED' } });
  assert.deepEqual(parseEntry(tEntry('2026-10-12T10:00:00Z', errText('r-8', 'PERMISSION_DENIED', 403))).cause, { requestId: 'r-8', cause: 'PERMISSION_DENIED' });
  // Truncated mid-JSON but the status field survived: recovered by pattern.
  assert.equal(parseEntry(tEntry('2026-10-12T10:00:00Z', '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=r-7: 429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exce')).cause.cause, 'RESOURCE_EXHAUSTED');
  const skip = [
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream serves claude-sonnet-4-5 (via auto_include_builtin_models): Sonnet 4.5 ...',   // not a request error
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=r-6: 429 {"error":{"code":429,"mess',                              // truncated before the status
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=r-6: 429 not json',
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=: 429 {"error":{"status":"X_Y"}}',                                  // no id
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=r 6: 429 {"error":{"status":"RESOURCE_EXHAUSTED"}}',                // junk id is not an id
    '[gateway] 2026-10-12T10:00:00Z warn vertex upstream 429 request_id=r-5: 429 {"error":{"status":"resource exhausted; drop table"}}',   // hostile cause
    '[gateway] 2026-10-12T10:00:00Z info upstreams 1: vertex(vertex)', 'plain text', '', '{broken json',
  ];
  for (const t of skip) assert.equal(parseEntry(tEntry('2026-10-12T10:00:00Z', t)), null, t.slice(0, 60));
  for (const bad of [null, undefined, {}, { jsonPayload: null }, { jsonPayload: 7 }, { textPayload: 5 }]) assert.equal(parseEntry(bad), null);
  for (const o of [{ evt: 'auth.denied' }, { request_id: undefined }, { request_id: 'bad id!' }, { status: 'abc' }, { status: 99 }, { status: 700 }, { status: 200.5 }]) {
    assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf(o))), null, JSON.stringify(o));
  }
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ ms: 'x' }))).event.ms, null, 'unknown latency stays unknown (null), it is not a 0 ms request');
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ ms: -5 }))).event.ms, null);
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ ms: undefined }))).event.ms, null);
  assert.equal(parseEntry(jEntry('2026-10-12T10:00:00Z', inf({ email: 'x'.repeat(5000) }))).event.email.length, 320);
});

// ---- ingest ----
test('ingest: builds the right query, aggregates events, persists a cursor', async () => {
  const { usage, cloud, store } = setup([
    jEntry('2026-10-12T10:00:00.100Z', inf({ request_id: 'a' })),
    jEntry('2026-10-12T10:00:01.100Z', inf({ request_id: 'b', status: 429, upstream: '' })),
    tEntry('2026-10-12T10:00:02.100Z', 'unrelated'), jEntry('2026-10-12T10:00:03Z', { evt: 'auth.denied' }),
  ]);
  assert.deepEqual(await usage.ingest(), { ingested: 2 });
  const b = cloud.bodies[0];
  assert.deepEqual(b.resourceNames, ['projects/proj-1']); assert.equal(b.orderBy, 'timestamp asc'); assert.equal(b.pageSize, 1000);
  assert.match(b.filter, /resource\.labels\.service_name="claude-gateway"/); assert.match(b.filter, /jsonPayload\.evt="inference"/); assert.match(b.filter, /textPayload:"warn vertex upstream"/);
  assert.deepEqual(cloud.calls.filter((c) => c.url.includes('entries:list')).map((c) => c.init.headers.authorization), ['Bearer tok-1']);
  const t = await total(usage); assert.equal(t.requests, 2); assert.equal(t.blocked, 1); assert.equal(t.ok, 1);
  const cur = await store.get('usage/cursor'); assert.equal(cur.ts, '2026-10-12T10:00:03.000000000Z'); assert.ok(Array.isArray(cur.ids));
});

test('ingest: a second run does not double count; new entries arrive once', async () => {
  const { usage, cloud } = setup([jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'a' })), jEntry('2026-10-12T10:00:05Z', inf({ request_id: 'b' }))]);
  await usage.ingest(); assert.deepEqual(await usage.ingest(), { ingested: 0 });
  cloud.entries.push(jEntry('2026-10-12T10:01:00Z', inf({ request_id: 'c' })));
  assert.deepEqual(await usage.ingest(), { ingested: 1 });
  assert.equal((await total(usage)).requests, 3);
});

test('ingest: follows nextPageToken (and tolerates empty pages with a token)', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => jEntry(`2026-10-12T10:00:${String(i).padStart(2, '0')}Z`, inf({ request_id: 'p' + i })));
  const { usage, cloud } = setup(entries, { cloud: { pageSize: 3 } });
  assert.deepEqual(await usage.ingest(), { ingested: 10 });
  assert.equal(cloud.calls.filter((c) => c.url.includes('entries:list')).length, 4);
  assert.deepEqual(cloud.bodies.map((b) => b.pageToken), [undefined, '3', '6', '9']);
  assert.equal((await total(usage)).requests, 10);
});

test('ingest: stops at the page cap, resumes from the cursor next run without gaps or repeats', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => jEntry(`2026-10-12T10:00:${String(i).padStart(2, '0')}Z`, inf({ request_id: 'p' + i })));
  const { usage } = setup(entries, { cloud: { pageSize: 3 }, create: { maxPages: 2 } });
  assert.deepEqual(await usage.ingest(), { ingested: 6 });
  assert.deepEqual(await usage.ingest(), { ingested: 4 });
  assert.deepEqual(await usage.ingest(), { ingested: 0 });
  assert.equal((await total(usage)).requests, 10);
});

test('ingest: entries sharing one timestamp are neither skipped nor repeated', async () => {
  const ts = '2026-10-12T10:00:00.500000000Z';
  const { usage, cloud } = setup([jEntry(ts, inf({ request_id: 'a' }), 'x1'), jEntry(ts, inf({ request_id: 'b' }), 'x2')], { cloud: { pageSize: 1 } });
  assert.deepEqual(await usage.ingest(), { ingested: 2 });
  cloud.entries.push(jEntry(ts, inf({ request_id: 'c' }), 'x3'));               // same instant, lands after the first run
  assert.deepEqual(await usage.ingest(), { ingested: 1 });
  assert.deepEqual(await usage.ingest(), { ingested: 0 });
  assert.equal((await total(usage)).requests, 3);
});

test('ingest: an entry that becomes visible late (older timestamp, inside the lookback) is counted once', async () => {
  const { usage, cloud } = setup([jEntry('2026-10-12T10:00:10Z', inf({ request_id: 'a' }))]);
  await usage.ingest();
  cloud.entries.push(jEntry('2026-10-12T10:00:04Z', inf({ request_id: 'late' })));
  assert.deepEqual(await usage.ingest(), { ingested: 1 });
  assert.deepEqual(await usage.ingest(), { ingested: 0 });
  assert.equal((await total(usage)).requests, 2);
});

test('ingest: upstream causes pair with events in either order, within a run and across runs', async () => {
  const { usage, cloud, aggregator } = setup([
    tEntry('2026-10-12T10:00:00Z', errText('before')), jEntry('2026-10-12T10:00:01Z', inf({ request_id: 'before', status: 429 })),   // cause first
    jEntry('2026-10-12T10:00:02Z', inf({ request_id: 'after', status: 403 })), tEntry('2026-10-12T10:00:03Z', errText('after', 'PERMISSION_DENIED', 403)),   // event first
  ]);
  await usage.ingest();
  cloud.entries.push(jEntry('2026-10-12T10:01:00Z', inf({ request_id: 'x-ev', status: 429 })));
  await usage.ingest();
  cloud.entries.push(tEntry('2026-10-12T10:02:00Z', errText('x-ev')));          // cause arrives in a later run
  cloud.entries.push(tEntry('2026-10-12T10:02:30Z', errText('x-pre', 'UNAVAILABLE', 503)));
  await usage.ingest();
  cloud.entries.push(jEntry('2026-10-12T10:03:00Z', inf({ request_id: 'x-pre', status: 503 })));
  await usage.ingest();
  const recent = (await aggregator.detail('u1', W, 50)).recent;
  const cause = (id) => recent.find((r) => r.id === id).cause;
  assert.equal(cause('before'), 'RESOURCE_EXHAUSTED'); assert.equal(cause('after'), 'PERMISSION_DENIED');
  assert.equal(cause('x-ev'), 'RESOURCE_EXHAUSTED'); assert.equal(cause('x-pre'), 'UNAVAILABLE');
  assert.equal(recent.find((r) => r.id === 'before').outcome, 'upstream_error');
});

test('ingest: first run backfills USAGE_BACKFILL_DAYS (default 30); a stored cursor wins afterwards', async () => {
  const a = setup([]); await a.usage.ingest();
  assert.match(a.cloud.bodies[0].filter, /timestamp>="2026-09-12T12:00:00\.000000000Z"/);
  const b = setup([], { env: { USAGE_BACKFILL_DAYS: '7' } }); await b.usage.ingest();
  assert.match(b.cloud.bodies[0].filter, /timestamp>="2026-10-05T12:00:00\.000000000Z"/);
  const c = setup([], { create: { backfillDays: 3 } }); await c.usage.ingest();
  assert.match(c.cloud.bodies[0].filter, /timestamp>="2026-10-09T12:00:00\.000000000Z"/);
  const d = setup([], { env: { USAGE_BACKFILL_DAYS: 'junk' } }); await d.usage.ingest();
  assert.match(d.cloud.bodies[0].filter, /timestamp>="2026-09-12T12:00:00/, 'junk falls back to 30 days');
  const e = setup([jEntry('2026-10-12T11:00:00Z', inf({ request_id: 'a' }))]); await e.usage.ingest(); await e.usage.ingest();
  assert.match(e.cloud.bodies[1].filter, /timestamp>="2026-10-12T10:58:00\.000000000Z"/, 'cursor minus the 2 minute lookback');
});

test('ingest: API 4xx, 5xx and timeouts surface a useful error and leave cursor and aggregates untouched', async () => {
  const entries = [jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'a' }))];
  for (const status of [400, 403, 429, 500, 503]) {
    const { usage, cloud, store } = setup(entries);
    cloud.fail = status;
    await assert.rejects(usage.ingest(), new RegExp(`cloud logging ${status}: boom ${status}`));
    assert.equal(await store.get('usage/cursor'), null); assert.equal((await total(usage)).requests, 0);
    assert.equal(await usage.ok(), false);
    cloud.fail = null;
    assert.deepEqual(await usage.ingest(), { ingested: 1 }, 'the next run recovers fully');
    assert.equal(await usage.ok(), true);
  }
  const { usage, cloud, store } = setup(entries, { create: { timeoutMs: 20 } });
  cloud.fail = 'hang';
  await assert.rejects(usage.ingest());
  assert.equal(await store.get('usage/cursor'), null);
  cloud.fail = null; assert.deepEqual(await usage.ingest(), { ingested: 1 });
});

test('ingest: a failure on a later page keeps the finished pages counted once, and the retry continues from there', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => jEntry(`2026-10-12T10:00:0${i}Z`, inf({ request_id: 'p' + i })));
  const { usage, cloud, store } = setup(entries, { cloud: { pageSize: 2 } });
  cloud.failAt = 2;
  await assert.rejects(usage.ingest(), /cloud logging 500/);
  assert.equal((await total(usage)).requests, 2);
  assert.equal((await store.get('usage/cursor')).ts, '2026-10-12T10:00:01.000000000Z');
  cloud.failAt = null;
  assert.deepEqual(await usage.ingest(), { ingested: 4 });
  assert.equal((await total(usage)).requests, 6);
});

test('ingest: an aggregator failure does not move the cursor', async () => {
  const { usage, aggregator, store } = setup([jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'a' }))]);
  const real = aggregator.add; let boom = true;
  aggregator.add = async (...a) => { if (boom) throw new Error('store down'); return real(...a); };
  await assert.rejects(usage.ingest(), /store down/);
  assert.equal(await store.get('usage/cursor'), null);
  boom = false; assert.deepEqual(await usage.ingest(), { ingested: 1 });
});

test('ingest: an unreadable cursor is an error, not a silent re-backfill', async () => {
  const { usage, store, cloud } = setup([jEntry('2026-10-12T10:00:00Z', inf())]);
  await store.put('usage/cursor', { ts: 'nonsense' });
  await assert.rejects(usage.ingest(), /usage\/cursor.*unreadable/);
  assert.equal(cloud.calls.length, 0); assert.equal((await total(usage)).requests, 0);
});

test('token: cached until expiry, refreshed after, and once after a 401', async () => {
  const ref = { v: NOW };
  const { usage, cloud } = setup([], { nowRef: ref, cloud: { expires: 300 } });
  await usage.ingest(); await usage.ingest();
  assert.equal(cloud.tokens, 1, 'second run reuses the token');
  ref.v += 10 * 60e3; await usage.ingest();
  assert.equal(cloud.tokens, 2, 'refreshed once it expired');
  const r = setup([jEntry('2026-10-12T10:00:00Z', inf())]); r.cloud.rejectFirstToken = true;
  assert.deepEqual(await r.usage.ingest(), { ingested: 1 });
  assert.equal(r.cloud.tokens, 2, 'a 401 triggers one refresh and one retry');
  const f = setup([]); f.cloud.fetch = async (u) => (String(u).endsWith('/token') ? new Response('nope', { status: 500 }) : assert.fail('must not call the API without a token'));
  const g = create(CFG, { store: f.store, aggregator: f.aggregator, fetchImpl: f.cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'p' } });
  await assert.rejects(g.ingest(), /metadata server/);
});

test('project id comes from GOOGLE_CLOUD_PROJECT, else the metadata server (and is cached)', async () => {
  const a = setup([], { env: { GOOGLE_CLOUD_PROJECT: '' }, cloud: { project: 'meta-proj' } });
  await a.usage.ingest(); await a.usage.ingest();
  assert.deepEqual(a.cloud.bodies[0].resourceNames, ['projects/meta-proj']);
  assert.equal(a.cloud.calls.filter((c) => c.url.endsWith('/project/project-id')).length, 1);
});

test('concurrent ingest calls share one run: no interleaving, no double counting', async () => {
  const entries = Array.from({ length: 8 }, (_, i) => jEntry(`2026-10-12T10:00:0${i}Z`, inf({ request_id: 'p' + i })));
  const { usage, cloud } = setup(entries, { cloud: { pageSize: 3 } });
  const [a, b, c] = await Promise.all([usage.ingest(), usage.ingest(), usage.ingest()]);
  assert.deepEqual([a, b, c], [{ ingested: 8 }, { ingested: 8 }, { ingested: 8 }]);
  assert.equal(cloud.calls.filter((x) => x.url.includes('entries:list')).length, 3, 'one run, three pages');
  assert.equal((await total(usage)).requests, 8);
  assert.deepEqual(await usage.ingest(), { ingested: 0 }, 'the lock is released afterwards');
});

test('a failed run releases the lock for the next call', async () => {
  const { usage, cloud } = setup([jEntry('2026-10-12T10:00:00Z', inf())]);
  cloud.fail = 500;
  await Promise.allSettled([usage.ingest(), usage.ingest()]);
  cloud.fail = null;
  assert.deepEqual(await usage.ingest(), { ingested: 1 });
});

test('a hostile service name never reaches the filter', async () => {
  const { usage, cloud } = setup([], {}, { gatewayService: 'x" OR severity>=DEBUG OR "' });
  await assert.rejects(usage.ingest(), /GATEWAY_SERVICE_NAME/);
  assert.equal(cloud.calls.filter((c) => c.url.includes('entries:list')).length, 0);
});

test('ok(): true after a good ingest, probes the API otherwise, false on failure, never throws', async () => {
  const a = setup([]);
  assert.equal(await a.usage.ok(), true, 'API answers');
  assert.match(a.cloud.bodies[0].filter, /resource\.type="cloud_run_revision"/); assert.equal(a.cloud.bodies[0].pageSize, 1);
  const b = setup([]); b.cloud.fail = 503;
  assert.equal(await b.usage.ok(), false);
  const c = setup([]); c.cloud.fetch = async () => { throw new TypeError('fetch failed'); };
  const u = create(CFG, { store: c.store, aggregator: c.aggregator, fetchImpl: c.cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'p' } });
  assert.equal(await u.ok(), false);
  await assert.rejects(u.ingest(), /fetch failed/); assert.equal(await u.ok(), false);
  assert.equal(u.status().lastError, 'fetch failed');
  const d = setup([jEntry('2026-10-12T10:00:00Z', inf())]); await d.usage.ingest(); d.cloud.fail = 500;
  assert.equal(await d.usage.ok(), true, 'a recent successful ingest counts');
});

test('reads go through the aggregator and match the contract shapes', async () => {
  const { usage } = setup([jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'a' })), jEntry('2026-10-12T10:05:00Z', inf({ request_id: 'b', status: 500, model: '' }))]);
  await usage.ingest();
  assert.equal(usage.source, 'logs');
  assert.deepEqual([...(await usage.roster())], [['u1', 'a@example.com']]);
  const u = await usage.users(W); assert.equal(u.rows[0].requests, 2); assert.equal(u.spark.get('u1').length, W.n);
  const d = await usage.detail('u1', W, 1); assert.equal(d.recent.length, 1); assert.deepEqual(Object.keys(d.recent[0]).sort(), ['cause', 'email', 'id', 'lt', 'model', 'ms', 'outcome', 'status', 'sub', 'ts']);
  const c = await usage.company(W); assert.deepEqual(Object.keys(c.totals).sort(), ['blocked', 'ok', 'rejected', 'requests', 'upstream_errors', 'users']);
});

test('load-test events are flagged and separable', async () => {
  const { usage } = setup([jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'a', load_test: true })), jEntry('2026-10-12T10:00:01Z', inf({ request_id: 'b' }))]);
  await usage.ingest();
  assert.equal((await total(usage, 'real')).requests, 1); assert.equal((await total(usage, 'loadtest')).requests, 1);
});

// ---- spend.blocked: the real gateway logs a refusal at a spend limit as its own event and NO inference event (fixtures from the real gateway) ----
const blocked = (o = {}) => ({ ts: '2026-10-12T10:30:00.500Z', evt: 'spend.blocked', request_id: 'b-1', sub: 'u1', cause: 'over_limit', cap_cents: '0', source: 'user', period: 'weekly', ...o });

test('parseEntry: spend.blocked becomes a 429 event with no upstream and an unknown model, with cause, period and cap', () => {
  const p = parseEntry(jEntry('2026-10-12T10:30:00.500Z', blocked()));
  assert.equal(p.blocked, true);
  assert.deepEqual(p.event, { ts: Date.parse('2026-10-12T10:30:00.500Z'), requestId: 'b-1', sub: 'u1', email: '', model: '', status: 429, ms: null, upstream: '', loadTest: false, cause: 'over_limit (weekly cap $0)' });
  assert.equal(parseEntry(jEntry('2026-10-12T10:30:00Z', blocked({ cap_cents: '15050', period: 'monthly', load_test: true }))).event.cause, 'over_limit (monthly cap $150.50)');
  assert.equal(parseEntry(jEntry('2026-10-12T10:30:00Z', blocked({ cap_cents: 'x', period: '<b>', cause: 'A B' }))).event.cause, 'over_limit', 'only known tokens reach the UI');
  assert.equal(parseEntry(jEntry('2026-10-12T10:30:00Z', blocked({ request_id: '' }))), null);
  assert.equal(parseEntry(jEntry('2026-10-12T10:30:00Z', blocked({ request_id: 'a b' }))), null);
});

test('the Cloud Logging filter asks for spend.blocked as well', async () => {
  const c = setup([jEntry('2026-10-12T10:00:00Z', inf())]); await c.usage.ingest();
  assert.match(c.cloud.lastBody.filter, /jsonPayload\.evt="spend\.blocked"/);
});

test('spend-cap blocks are counted in users(), detail() (with cause) and company(); e-mail comes from the roster; ingested counts inference events only', async () => {
  const { usage } = setup([
    jEntry('2026-10-12T10:00:00Z', inf({ request_id: 'ok1' })),
    jEntry('2026-10-12T10:30:00.500Z', blocked({ request_id: 'blk1' })),
    jEntry('2026-10-12T10:31:00Z', blocked({ request_id: 'blk2', sub: 'u2', period: 'daily', cap_cents: '500', load_test: true })),
  ]);
  assert.deepEqual(await usage.ingest(), { ingested: 1 });
  const c = await usage.company(W);
  assert.deepEqual(c.totals, { requests: 3, ok: 1, upstream_errors: 0, blocked: 2, rejected: 0, users: 2 });
  assert.equal((await usage.company({ ...W, data: 'real' })).totals.blocked, 1, 'a load-test block is flagged like any load-test event');
  const u = (await usage.users(W)).rows.find((r) => r.sub === 'u1'); assert.deepEqual([u.requests, u.ok, u.email], [2, 1, 'a@example.com']);
  const d = await usage.detail('u1', W);
  const b = d.recent.find((r) => r.id === 'blk1');
  assert.deepEqual([b.outcome, b.status, b.model, b.cause, b.email, b.ms], ['spend_cap', 429, '', 'over_limit (weekly cap $0)', 'a@example.com', 0]);
  assert.equal(d.models.find((m) => m.model === '(none)').requests, 1, 'the unknown model is "(none)" in the per-model table');
  assert.equal(d.models.find((m) => m.model === '(none)').p50, null);
  assert.equal(d.recent[0].id, 'blk1', 'newest first');
  assert.equal((await usage.ingest()).ingested, 0); assert.equal((await total(usage)).blocked, 2, 're-reading the log does not count a block twice');
});

test('M2: a failure after the day docs were written (any later store call) never double counts on the next run', async () => {
  const entries = [0, 1, 2].map((i) => jEntry(`2026-10-12T10:00:0${i}.100Z`, inf({ request_id: 'm' + i, ts: `2026-10-12T10:00:0${i}.100Z` }))).concat([jEntry('2026-10-12T10:00:04Z', blocked({ request_id: 'mb' }))]);
  for (const [op, key] of [['update', 'usage/roster'], ['update', 'usage/causes'], ['update', 'usage/recent/'], ['put', 'usage/cursor']]) {
    const store = createMemoryStore(); let armed = true;
    const flaky = new Proxy(store, { get: (t, k) => (k === op ? async (name, ...a) => { if (armed && name.startsWith(key)) { armed = false; throw new Error('storage conflict (injected)'); } return t[k](name, ...a); } : t[k]) });
    const aggregator = createAggregator(flaky, { now: () => NOW });
    const usage = create(CFG, { store: flaky, aggregator, fetchImpl: fakeCloud({ entries }).fetch, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: () => NOW });
    await assert.rejects(usage.ingest(), /injected/, key);
    await usage.ingest();
    assert.equal((await usage.company(W)).totals.requests, 4, `${op} ${key} failed once, then replayed`);
    assert.equal((await usage.detail('u1', W, 50)).recent.length, 4);
  }
});

test('an unreadable cursor fails the run loudly and does not restart the backfill', async () => {
  const c = setup([jEntry('2026-10-12T10:00:00Z', inf())]); await c.usage.ingest();
  await c.store.put('usage/cursor', { ts: 'garbage' });
  await assert.rejects(c.usage.ingest(), /unreadable/);
  assert.equal((await total(c.usage)).requests, 1);
  const f = setup([jEntry('2026-10-12T10:00:00Z', inf())]); await f.usage.ingest();
  f.store.get = async (name, fb) => { if (name === 'usage/cursor') throw new Error('state file cursor.json is corrupt'); return f.aggregator && (await createMemoryStore().get(name, fb)); };
  await assert.rejects(f.usage.ingest(), /corrupt/);
});

test('a scoped log view (cfg.usageLogsView) is queried instead of the whole project', async () => {
  const view = 'projects/proj-1/locations/global/buckets/_Default/views/claude-gateway-logs';
  const scoped = setup([], {}, { ...CFG, usageLogsView: view });
  await scoped.usage.ingest();
  assert.deepEqual(scoped.cloud.lastBody.resourceNames, [view], 'only the gateway view is read');
  const open = setup([]);
  await open.usage.ingest();
  assert.deepEqual(open.cloud.lastBody.resourceNames, ['projects/proj-1'], 'default: the project, as before');
});
