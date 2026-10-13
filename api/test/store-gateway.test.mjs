import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore, createGcsStore, createMemoryStore } from '../lib/store.mjs';
import { createMemoryGateway } from '../lib/gateway.mjs';

for (const [name, make] of [['memory', () => createMemoryStore()], ['file', () => createFileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')))]]) {
  test(`${name} store: get/put/update/list and serialised updates`, async () => {
    const s = make();
    assert.equal(await s.get('a', 'fb'), 'fb');
    await s.put('x/one', { n: 1 });
    assert.deepEqual(await s.get('x/one'), { n: 1 });
    await Promise.all(Array.from({ length: 20 }, () => s.update('counter', (c) => ({ n: c.n + 1 }), { n: 0 })));
    assert.equal((await s.get('counter')).n, 20, 'concurrent updates must not lose writes');
    await s.put('x/two', {});
    assert.deepEqual(await s.list('x/'), ['x/one', 'x/two']);
  });
}

test('gcs store: optimistic concurrency retries on 412', async () => {
  let gen = 5, value = { n: 0 }, conflicts = 1;
  const fetchImpl = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('metadata.google.internal')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (u.includes('/upload/')) {
      if (conflicts-- > 0) return new Response('{}', { status: 412 });
      assert.match(u, /ifGenerationMatch=5/); value = JSON.parse(opt.body); gen++; return new Response('{}');
    }
    if (u.includes('alt=media')) return new Response(JSON.stringify(value));
    return new Response(JSON.stringify({ generation: String(gen) }));
  };
  const s = createGcsStore('b', { fetchImpl });
  const out = await s.update('doc', (c) => ({ n: c.n + 1 }), { n: 0 });
  assert.equal(out.n, 1); assert.equal(value.n, 1);
});

test('memory gateway: personal cap overrides org default, unlimited override, audit attribution', async () => {
  const gw = createMemoryGateway({ users: [{ sub: 'u1', email: 'a@x.io', name: 'A' }] });
  const who = { key: 'k', actor: 'admin@x.io' };
  await gw.upsert({ type: 'organization' }, 'monthly', 10000, who);
  let [, , m] = await gw.effective(['u1']);
  assert.equal(m.amount, '10000'); assert.equal(m.source.type, 'organization');
  const own = await gw.upsert({ type: 'user', user_id: 'u1' }, 'monthly', 25000, who);
  [, , m] = await gw.effective(['u1']); assert.equal(m.amount, '25000'); assert.equal(m.source.type, 'user');
  await gw.upsert({ type: 'user', user_id: 'u1' }, 'monthly', null, who);
  [, , m] = await gw.effective(['u1']); assert.equal(m.amount, null); assert.equal(m.source.type, 'user');
  await gw.remove(own.id, who);
  [, , m] = await gw.effective(['u1']); assert.equal(m.amount, '10000');
  const a = await gw.audit(10); assert.equal(a[0].actor, 'admin-key:admin@x.io'); assert.equal(a[0].action, 'spend_limit.delete');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Data-integrity regressions (adversarial review H2/M1) and twin fidelity (checked against the real gateway by tests/e2e/l1)
// ---------------------------------------------------------------------------------------------------------------------------------
function gcsFake(initial = {}) {
  const objs = new Map(Object.entries(initial).map(([k, v]) => [k, { gen: 5, value: v }]));
  const f = { objs, writes: 0, media: null, meta: null, mediaHeaders: null, calls: [] };
  const nameOf = (u) => decodeURIComponent(/\/o\/([^?]+)/.exec(u)?.[1] ?? new URL(u).searchParams.get('name'));
  f.fetch = async (url, opt = {}) => {
    const u = String(url); f.calls.push(u);
    if (u.includes('metadata.google.internal')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (/\/storage\/v1\/b\/[^/?]+$/.test(u)) return f.bucket ? f.bucket(u) : new Response('{}');
    const name = nameOf(u).replace(/\.json$/, '');
    if (u.includes('/upload/')) { f.writes++; const want = Number(/ifGenerationMatch=(\d+)/.exec(u)[1]); const cur = objs.get(name)?.gen ?? 0; if (want !== cur) return new Response('{}', { status: 412 }); objs.set(name, { gen: cur + 1, value: JSON.parse(opt.body) }); return new Response('{}'); }
    const o = objs.get(name);
    if (u.includes('alt=media')) {
      if (f.media) return f.media(u, o);
      return new Response(JSON.stringify(o.value), { headers: { 'x-goog-generation': String(o.gen), ...(f.mediaHeaders || {}) } });
    }
    if (f.meta) return f.meta(u, o);
    if (!o) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ generation: String(o.gen) }));
  };
  return f;
}

test('M1 gcs: a 5xx on the media download throws and nothing is written (the old code treated the error body as the document)', async () => {
  const f = gcsFake({ 'usage/roster': { alice: { email: 'a@x.io' } } });
  const s = createGcsStore('b', { fetchImpl: f.fetch });
  f.media = async () => new Response(JSON.stringify({ error: { code: 503 } }), { status: 503 });
  await assert.rejects(s.update('usage/roster', (d) => ({ ...d, bob: {} }), {}), /storage read 503/);
  await assert.rejects(s.get('usage/roster', {}), /storage read 503/);
  assert.equal(f.writes, 0); assert.deepEqual(Object.keys(f.objs.get('usage/roster').value), ['alice']);
  f.media = null;
  assert.deepEqual(Object.keys(await s.update('usage/roster', (d) => ({ ...d, bob: {} }), {})), ['alice', 'bob']);
});

test('M1 gcs: only a 404 on the metadata means missing; a 500 there, bad JSON, or a missing generation throw', async () => {
  const f = gcsFake({ doc: { n: 1 } }); const s = createGcsStore('b', { fetchImpl: f.fetch });
  assert.equal(await s.get('nope', 'fb'), 'fb');
  f.meta = async () => new Response('{}', { status: 500 });
  await assert.rejects(s.get('doc'), /storage read 500/); await assert.rejects(s.put('doc', { n: 2 }), /storage read 500/);
  f.meta = async () => new Response('{}'); await assert.rejects(s.get('doc'), /no generation/);
  f.meta = null; f.media = async () => new Response('<html>proxy error</html>'); await assert.rejects(s.get('doc'), /not valid JSON/);
  await assert.rejects(s.update('doc', () => ({ n: 9 }), {}), /not valid JSON/);
  assert.equal(f.writes, 0); assert.deepEqual(f.objs.get('doc').value, { n: 1 });
});

test('M1 gcs: the media is fetched for exactly the generation the metadata named; a body from another generation is re-read, never used', async () => {
  const f = gcsFake({ doc: { n: 1 } }); const s = createGcsStore('b', { fetchImpl: f.fetch });
  await s.get('doc');
  assert.ok(f.calls.some((u) => /alt=media&generation=5/.test(u)), f.calls.join('\n'));
  let n = 0; f.media = async (u, o) => (n++ === 0 ? new Response(JSON.stringify({ n: 'STALE' }), { headers: { 'x-goog-generation': '4' } }) : new Response(JSON.stringify(o.value), { headers: { 'x-goog-generation': String(o.gen) } }));
  assert.deepEqual(await s.get('doc'), { n: 1 });
  let m = 0; f.media = async (u, o) => (m++ === 0 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(o.value)));   // replaced between the two calls
  assert.deepEqual(await s.get('doc'), { n: 1 });
  f.media = async () => new Response('{}', { status: 404 });
  await assert.rejects(s.get('doc'), /kept changing/);
});

test('twin: negative / non-numeric amounts, unknown periods and bad scopes are 400 like the real gateway; nothing is stored', async () => {
  const gw = createMemoryGateway({ users: [{ sub: 'u1', email: 'a@x.io', name: 'A' }] }); const who = { key: 'k', actor: 'a' };
  for (const c of [-5, 1.5, '12', NaN, Infinity, undefined, 1e21]) await assert.rejects(gw.upsert({ type: 'organization' }, 'weekly', c, who), (e) => e.status === 400, String(c));
  await assert.rejects(gw.upsert({ type: 'organization' }, 'yearly', 5, who), (e) => e.status === 400);
  await assert.rejects(gw.upsert({ type: 'planet' }, 'weekly', 5, who), (e) => e.status === 400);
  await assert.rejects(gw.upsert({ type: 'user' }, 'weekly', 5, who), (e) => e.status === 400, 'a user scope needs a user_id');
  assert.deepEqual(await gw.listLimits(), []);
  await gw.upsert({ type: 'organization' }, 'weekly', 0, who); await gw.upsert({ type: 'organization' }, 'monthly', null, who);   // zero and unlimited are valid
  assert.equal((await gw.listLimits()).length, 2);
});

test('twin: results have the real shapes (upsert -> type:spend_limit, remove -> {type:spend_limit_deleted,id}); `keys` makes it strict about write permission', async () => {
  const gw = createMemoryGateway({ keys: { RK: 'read', WK: 'write' } });
  const who = { key: 'WK', actor: 'a' };
  const made = await gw.upsert({ type: 'organization' }, 'weekly', 100, who);
  assert.equal(made.type, 'spend_limit'); assert.deepEqual(Object.keys(made).sort(), ['amount', 'created_at', 'currency', 'id', 'period', 'scope', 'type', 'updated_at']);
  assert.equal((await gw.upsert({ type: 'organization' }, 'weekly', 200, who)).type, 'spend_limit');
  await assert.rejects(gw.upsert({ type: 'organization' }, 'weekly', 1, { key: 'RK', actor: 'x' }), (e) => e.status === 502, 'a read key cannot write (the real client reports 403 as 502)');
  await assert.rejects(gw.upsert({ type: 'organization' }, 'weekly', 1, { key: 'nope', actor: 'x' }), (e) => e.status === 502);
  await assert.rejects(gw.remove(made.id, { key: 'RK', actor: 'x' }), (e) => e.status === 502);
  assert.equal((await gw.listLimits())[0].amount, '200');
  assert.deepEqual(await gw.remove(made.id, who), { type: 'spend_limit_deleted', id: made.id });
  await assert.rejects(gw.remove(made.id, who), (e) => e.status === 404);
  const open = createMemoryGateway(); await open.upsert({ type: 'organization' }, 'weekly', 1, { key: 'anything', actor: 'demo' });   // default stays permissive for demo mode
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Round 2: N6 names and quarantine honesty, N7 shape, N8 gcs token/bucket, N9 gateway paging
// ---------------------------------------------------------------------------------------------------------------------------------
import { StoreError } from '../lib/store.mjs';
import { createHttpGateway } from '../lib/gateway.mjs';

test('N6: document names that are absolute, contain .. or backslashes, or are empty are refused by every store (nothing is written outside the data dir)', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'names-')), dir = path.join(parent, 'data'); fs.mkdirSync(dir);
  const f = gcsFake(); const stores = [createMemoryStore(), createFileStore(dir), createGcsStore('b', { fetchImpl: f.fetch })];
  for (const s of stores) for (const bad of ['../esc', '/abs', 'a\\b', 'a/../../b', '', 'a//b', './x', 'a/./b', '..', null, 5]) {
    await assert.rejects(s.put(bad, { a: 1 }), StoreError, `${s.kind} put ${JSON.stringify(bad)}`);
    await assert.rejects(s.get(bad, null), StoreError); await assert.rejects(s.update(bad, (d) => d, {}), StoreError);
  }
  await assert.rejects(stores[1].list('../'), StoreError); await assert.rejects(stores[1].list('/etc'), StoreError);
  assert.deepEqual(fs.readdirSync(parent), ['data']); assert.deepEqual(fs.readdirSync(dir), []); assert.equal(f.writes, 0);
  await stores[1].put('ok/name-1.v2', { a: 1 }); assert.deepEqual(await stores[1].get('ok/name-1.v2'), { a: 1 });
});

test('N6: the quarantine marker is only set once a copy exists (a failed copy is retried, and never reported as made)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quar-')); const s = createFileStore(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), '{bad'); fs.chmodSync(dir, 0o555);               // the copy cannot be written
  try {
    await assert.rejects(s.get('a'), (e) => e instanceof StoreError && /no copy could be made/.test(e.message) && !e.quarantined);
    await assert.rejects(s.update('a', (d) => d, {}), /no copy could be made/);
  } finally { fs.chmodSync(dir, 0o755); }
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('corrupt')).length, 0);
  await assert.rejects(s.get('a'), (e) => /a copy was kept as a\.json\.corrupt-/.test(e.message) && /^a\.json\.corrupt-/.test(e.quarantined));   // now it works
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('corrupt')).length, 1);
  await assert.rejects(s.get('a'), StoreError); assert.equal(fs.readdirSync(dir).filter((n) => n.includes('corrupt')).length, 1, 'and only once');
});

test('N7: opts.shape makes valid JSON of the wrong shape as loud as torn JSON, in every store (file: copied + untouched)', async () => {
  const shape = (v) => !!v && typeof v === 'object' && Array.isArray(v.items);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape2-')); const file = createFileStore(dir), mem = createMemoryStore(), g = gcsFake(), gcs = createGcsStore('b', { fetchImpl: g.fetch });
  for (const bad of [{}, null, [], { items: null }, 'x', 5]) {
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(bad)); await mem.put('d', bad); g.objs.set('d', { gen: 7, value: bad });
    for (const s of [file, mem, gcs]) {
      await assert.rejects(s.get('d', { items: [] }, { shape }), (e) => e instanceof StoreError && /unexpected shape/.test(e.message), `${s.kind} get ${JSON.stringify(bad)}`);
      await assert.rejects(s.update('d', (d) => d, { items: [] }, { shape }), /unexpected shape/);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'd.json'), 'utf8'), JSON.stringify(bad));
  }
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('d.json.corrupt-')));
  assert.equal(g.writes, 0);
  for (const s of [file, mem, gcs]) assert.deepEqual(await s.get('missing-doc', { items: [] }, { shape }), { items: [] }, 'a missing document is still just the fallback');
  fs.writeFileSync(path.join(dir, 'd.json'), '{"items":[1]}'); assert.deepEqual(await file.get('d', null, { shape }), { items: [1] });
  assert.deepEqual(await file.get('d'), { items: [1] }, 'without a shape option anything valid is accepted');
});

test('N8 gcs: a 401 refreshes the token once and retries; a persistent 401 fails instead of looping', async () => {
  const f = gcsFake({ doc: { n: 1 } }); let tokens = 0, rejectOld = true;
  const inner = f.fetch;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('metadata.google.internal')) { tokens++; return new Response(JSON.stringify({ access_token: 'tok' + tokens, expires_in: 3600 })); }
    if (rejectOld && init.headers?.authorization === 'Bearer tok1') return new Response('{"error":"unauthenticated"}', { status: 401 });
    return inner(url, init);
  };
  const s = createGcsStore('b', { fetchImpl });
  assert.deepEqual(await s.get('doc'), { n: 1 }); assert.equal(tokens, 2, 'refreshed exactly once');
  assert.deepEqual(await s.update('doc', (d) => ({ n: d.n + 1 }), {}), { n: 2 });
  const always = createGcsStore('b', { fetchImpl: async (u) => (String(u).includes('metadata') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response('{}', { status: 401 })) });
  await assert.rejects(always.get('doc'), /storage read 401/);
});

test('N8 gcs: a 404 for an object only means "empty" if the bucket exists (checked once and cached); a wrong bucket name is a loud StoreError', async () => {
  const f = gcsFake(); const s = createGcsStore('good', { fetchImpl: f.fetch });
  assert.equal(await s.get('nope', 'fb'), 'fb'); assert.equal(await s.get('nope2', 'fb'), 'fb');
  assert.equal(f.calls.filter((u) => /\/storage\/v1\/b\/good$/.test(u)).length, 1, 'bucket verified once');
  const w = gcsFake(); w.bucket = () => new Response('{"error":{"code":404,"message":"The specified bucket does not exist."}}', { status: 404 });
  const wrong = createGcsStore('typo', { fetchImpl: w.fetch });
  await assert.rejects(wrong.get('overrides', { items: [] }), (e) => e instanceof StoreError && /bucket typo does not exist/.test(e.message));
  await assert.rejects(wrong.update('overrides', (d) => d, { items: [] }), /bucket typo does not exist/); await assert.rejects(wrong.put('overrides', {}), /bucket typo/);
  assert.equal(w.writes, 0);
  w.bucket = () => new Response('{}', { status: 403 }); await assert.rejects(createGcsStore('b', { fetchImpl: w.fetch }).get('x'), /bucket check 403/);
});

test('N9: gateway paging never silently truncates: 100 pages are followed, then it throws 502 instead of returning a partial list', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  const page = (n, more) => new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ id: 'spl_' + calls + '_' + i, scope: { type: 'user', user_id: 'x' + i }, period: 'weekly', amount: '1' })), has_more: more, last_id: 'spl_last' }));
  try {
    const gw = createHttpGateway({ gatewayUrl: 'http://gw.invalid', readKey: 'rk', gatewayAudience: '' });
    globalThis.fetch = async () => { calls++; return page(3, calls < 3); };
    assert.equal((await gw.listLimits()).length, 9, 'three pages followed');
    calls = 0; globalThis.fetch = async () => { calls++; return page(2, true); };
    await assert.rejects(gw.listLimits(), (e) => e.status === 502 && /too many spend limits/.test(e.message));
    assert.equal(calls, 100, 'the cap is 100 pages');
    calls = 0; globalThis.fetch = async () => { calls++; return page(1, calls < 100); };
    assert.equal((await gw.listLimits()).length, 100, 'exactly 100 pages is still fine');
  } finally { globalThis.fetch = realFetch; }
});
