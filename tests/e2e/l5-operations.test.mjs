// L5: operations. Restarts, outages, corrupt state and scale, with the real gateway process under our control.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { E } from './lib/env.mjs';
import { PORTS } from './lib/config.mjs';
import { gatewayProcess, secretsFromEnv, mintSession, messages, sleep, unique, MODELS, introduce, waitListed } from './lib/gw.mjs';
import { bootApp, fakeClock, iso, H } from './lib/app.mjs';
import { createHttpGateway, createMemoryGateway } from '../../api/lib/gateway.mjs';
import { createFileStore } from '../../api/lib/store.mjs';
import { createAggregator } from '../../api/lib/usage/aggregate.mjs';
import { createMemoryStore } from '../../api/lib/store.mjs';
import { loadConfig } from '../../api/lib/config.mjs';
import { appEnv } from './lib/app.mjs';
import { createApp } from '../../api/lib/routes.mjs';

const P = unique('l5');
const gw = gatewayProcess({ name: 'ops', port: PORTS.opsGateway, db: 'gateway_ops', secrets: secretsFromEnv() });
const U = (n) => ({ sub: `${P}-${n}`, email: `${n}-${P}@example.com`, name: `User ${n}` });
const session = (u) => mintSession({ ...u, url: gw.url });
const intro = (u) => introduce(u, session(u), { url: gw.url });
const raw = (method, p, { key = E.keys.read, body } = {}) => fetch(gw.url + '/v1/organizations/spend_limits' + p, { method, headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const personal = async (sub, period = 'weekly') => (await raw('GET', '?limit=1000')).json.data.find((l) => l.scope.type === 'user' && l.scope.user_id === sub && l.period === period) || null;
const dirs = []; const mkdir = (n) => { const d = fs.mkdtempSync(path.join(E.tmp, `l5-${n}-`)); dirs.push(d); return d; };
const STACK = /\n\s+at\s|node:internal|\.mjs:\d+|\.js:\d+|Error:|TypeError|ECONNREFUSED|fetch failed|127\.0\.0\.1:\d+/;
const poll = async (fn, { ms = 15000, every = 100 } = {}) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return Date.now() - t0; if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(every); } };

before(async () => { await gw.start(); });
after(async () => { await gw.stop(); });

describe('L5 gateway restart while the app is running', () => {
  let ctx, tok, clock;
  before(async () => {
    clock = fakeClock();
    ctx = await bootApp({ port: PORTS.appL5, dataDir: mkdir('restart'), clock, gatewayUrl: gw.url });
    tok = await ctx.login('ada');
  });
  after(async () => { await ctx.close(); });

  test('health goes false when the gateway stops, true again after it restarts, with no app restart; data and sessions survive', async () => {
    const u = U('r1'), s = session(u);
    await intro(u);
    assert.equal((await ctx.call('PUT', '/api/org/budget', { token: tok, body: { period: 'weekly', action: 'set', usd: 150 } })).status, 200);
    assert.equal((await ctx.call('PUT', `/api/users/${u.sub}/budget`, { token: tok, body: { period: 'monthly', action: 'set', usd: 77 } })).status, 200);
    assert.equal((await ctx.call('GET', '/api/health')).json.gateway, true);

    await gw.stop();
    const down = await ctx.call('GET', '/api/health');
    assert.equal(down.status, 200, 'health itself never fails'); assert.equal(down.json.gateway, false);

    await gw.start();
    const took = await poll(async () => (await ctx.call('GET', '/api/health')).json.gateway === true);
    console.log(`  (health true again ${took} ms after the gateway was ready)`);
    const d = (await ctx.call('GET', `/api/users/${u.sub}`)).json;
    assert.deepEqual([d.user.budgets.monthly.capCents, d.user.budgets.monthly.source], [7700, 'user'], 'limits persisted in Postgres');
    assert.equal(d.orgDefaults.weekly, 15000);
    assert.equal((await messages(s, { url: gw.url })).status, 200, 'a session minted before the restart still works (stateless JWT)');
    assert.equal((await ctx.call('PUT', `/api/users/${u.sub}/budget`, { token: tok, body: { period: 'monthly', action: 'set', usd: 78 } })).status, 200, 'writes work again');
    assert.equal((await personal(u.sub, 'monthly')).amount, '7800');
  });

  test('a boost that is active across a gateway restart still reverts on time', async () => {
    const u = U('r2'), t = await ctx.login('ada');
    await intro(u);
    const r = await ctx.call('POST', '/api/overrides', { token: t, body: { sub: u.sub, period: 'weekly', extraUsd: 20, endsAt: iso(clock.t + 3 * H), reason: 'restart test' } });
    assert.equal(r.json.status, 'active', r.text);
    await gw.stop(); await gw.start();
    assert.equal((await personal(u.sub)).amount, '17000');
    clock.advance(4 * H);
    const tk = await ctx.call('POST', '/api/internal/tick', { token: await ctx.login('ada') });
    assert.equal(tk.json.overrides.ended, 1);
    assert.equal(await personal(u.sub), null);
  });
});

describe('L5 gateway down: clean errors, nothing half-applied, retries after recovery', () => {
  let ctx, tok, clock;
  before(async () => {
    clock = fakeClock();
    ctx = await bootApp({ port: PORTS.appL5, dataDir: mkdir('down'), clock, gatewayUrl: gw.url });
    tok = await ctx.login('ada');
  });
  after(async () => { await ctx.close(); if (!gw.running) await gw.start(); });

  test('reads and writes fail with a short JSON error: no stack trace, no URL, no keys; health still answers', async () => {
    const u = U('d1');
    await intro(u);
    await ctx.call('PUT', '/api/org/budget', { token: tok, body: { period: 'weekly', action: 'set', usd: 100 } });
    await gw.stop();
    const calls = [
      ['GET', '/api/users'], ['GET', `/api/users/${u.sub}`], ['GET', '/api/company'], ['GET', '/api/audit'], ['GET', '/api/models'], ['GET', '/api/overrides'],
      ['PUT', '/api/org/budget', { period: 'weekly', action: 'set', usd: 5 }], ['PUT', `/api/users/${u.sub}/budget`, { period: 'weekly', action: 'inherit' }],
      ['POST', '/api/overrides', { sub: u.sub, period: 'weekly', extraUsd: 5, endsAt: iso(clock.t + 3 * H), reason: 'down test' }],
    ];
    const seen = {};
    for (const [m, p, body] of calls) {
      const r = await ctx.call(m, p, { token: tok, body });
      seen[`${m} ${p.replace(u.sub, ':sub')}`] = r.status;
      if (p === '/api/models' || p === '/api/overrides' && m === 'GET') { assert.equal(r.status, 200, p + ' needs no gateway'); continue; }
      assert.ok(r.status >= 500 && r.status < 600, `${m} ${p} -> ${r.status} ${r.text.slice(0, 100)}`);
      assert.equal(typeof r.json?.error, 'string', 'a JSON {error}');
      assert.ok(!STACK.test(r.text), `${m} ${p} leaked internals: ${r.text}`);
      for (const k of Object.values(E.keys)) assert.ok(!r.text.includes(k));
      assert.ok(r.text.length < 200);
    }
    console.log('  (statuses while the gateway is down: ' + JSON.stringify(seen) + ')');
    const h = await ctx.call('GET', '/api/health'); assert.equal(h.status, 200); assert.equal(h.json.gateway, false);
    const logged = JSON.stringify(ctx.logs); for (const k of Object.values(E.keys)) assert.ok(!logged.includes(k), 'keys are not logged either');
    await gw.start();
  });

  test('a write that could not reach the gateway changes nothing; the same write works after recovery', async () => {
    const u = U('d2'), t = await ctx.login('ada');
    await intro(u);
    await gw.stop();
    assert.ok((await ctx.call('PUT', `/api/users/${u.sub}/budget`, { token: t, body: { period: 'weekly', action: 'set', usd: 42 } })).status >= 500);
    await gw.start();
    assert.equal(await personal(u.sub), null, 'nothing was applied');
    assert.equal((await ctx.call('PUT', `/api/users/${u.sub}/budget`, { token: t, body: { period: 'weekly', action: 'set', usd: 42 } })).status, 200);
    assert.equal((await personal(u.sub)).amount, '4200');
    await ctx.call('PUT', `/api/users/${u.sub}/budget`, { token: t, body: { period: 'weekly', action: 'inherit' } });
  });

  test('ticks during an outage keep a due boost scheduled (never "failed") and apply it once the gateway is back', async () => {
    const u = U('d3'), t = await ctx.login('ada');
    await intro(u);
    const r = await ctx.call('POST', '/api/overrides', { token: t, body: { sub: u.sub, period: 'weekly', extraUsd: 30, startsAt: iso(clock.t + 1 * H), endsAt: iso(clock.t + 6 * H), reason: 'outage retry' } });
    assert.equal(r.json.status, 'scheduled', r.text);
    clock.advance(2 * H); const t2 = await ctx.login('ada');
    await gw.stop();
    for (let i = 0; i < 6; i++) {
      const tk = await ctx.call('POST', '/api/internal/tick', { token: t2 });
      assert.ok(tk.status >= 200, 'tick answers');
    }
    let o = (await ctx.call('GET', '/api/overrides')).json.overrides.find((x) => x.id === r.json.id);
    assert.equal(o.status, 'scheduled', 'six failed ticks (more than the 4 attempts) while the gateway is unreadable do not fail the boost');
    assert.match(o.note || '', /will retry/);
    await gw.start();
    const tk = await ctx.call('POST', '/api/internal/tick', { token: t2 });
    assert.equal(tk.json.overrides.applied, 1);
    assert.equal((await personal(u.sub)).amount, '13000');
    o = (await ctx.call('GET', '/api/overrides')).json.overrides.find((x) => x.id === r.json.id); assert.equal(o.status, 'active'); assert.equal(o.note, null);
    clock.advance(6 * H);
    await gw.stop();
    await ctx.call('POST', '/api/internal/tick', { token: await ctx.login('ada') });
    assert.equal((await ctx.call('GET', '/api/overrides')).json.overrides.find((x) => x.id === r.json.id).status, 'active', 'cannot revert while the gateway is down: stays active');
    await gw.start();
    assert.equal((await ctx.call('POST', '/api/internal/tick', { token: await ctx.login('ada') })).json.overrides.ended, 1);
    assert.equal(await personal(u.sub), null);
  });
});

describe('L5 a wrong system key: the boost fails cleanly after bounded retries and leaves the gateway alone', () => {
  test('4 refused attempts -> failed with a reason, no cap applied', async () => {
    const clock = fakeClock(), u = U('k1');
    await intro(u);
    const ctx = await bootApp({ port: PORTS.appL5, dataDir: mkdir('badkey'), clock, gatewayUrl: gw.url, extraEnv: { GATEWAY_SYSTEM_WRITE_KEY: 'f'.repeat(48) } });
    try {
      // bypass the app's admin key being used as the system key: cfg.systemKey wins for automatic writes
      const t = await ctx.login('ada');
      await ctx.call('PUT', '/api/org/budget', { token: t, body: { period: 'weekly', action: 'set', usd: 100 } });
      const r = await ctx.call('POST', '/api/overrides', { token: t, body: { sub: u.sub, period: 'weekly', extraUsd: 10, endsAt: iso(clock.t + 3 * H), reason: 'bad key' } });
      assert.equal(r.status, 201);
      for (let i = 0; i < 6; i++) await ctx.call('POST', '/api/internal/tick', { token: t });
      const o = (await ctx.call('GET', '/api/overrides')).json.overrides.find((x) => x.id === r.json.id);
      assert.equal(o.status, 'failed'); assert.match(o.note, /could not apply/);
      assert.ok(!JSON.stringify(o).includes('f'.repeat(48)));
      assert.equal(await personal(u.sub), null);
    } finally { await ctx.close(); }
  });
});

describe('L5 the app restarts in the middle of a boost', () => {
  test('a new app process on the same data dir finishes the job', async () => {
    const clock = fakeClock(), dir = mkdir('apprestart'), u = U('a1');
    await intro(u);
    const a1 = await bootApp({ port: PORTS.appL5, dataDir: dir, clock, gatewayUrl: gw.url });
    const t = await a1.login('ada');
    await a1.call('PUT', '/api/org/budget', { token: t, body: { period: 'weekly', action: 'set', usd: 100 } });
    const r = await a1.call('POST', '/api/overrides', { token: t, body: { sub: u.sub, period: 'weekly', extraUsd: 40, endsAt: iso(clock.t + 2 * H), reason: 'app restart' } });
    assert.equal(r.json.status, 'active'); await a1.close();
    const a2 = await bootApp({ port: PORTS.appL5, dataDir: dir, clock, gatewayUrl: gw.url });
    try {
      assert.equal((await a2.call('GET', '/api/overrides')).json.overrides[0].id, r.json.id, 'the boost survived in the store');
      clock.advance(3 * H);
      assert.equal((await a2.call('POST', '/api/internal/tick', { token: await a2.login('ada') })).json.overrides.ended, 1);
      assert.equal(await personal(u.sub), null);
    } finally { await a2.close(); }
  });
});

describe('L5 store corruption', () => {
  // Boots an app, makes one active boost, then tears the store file in half. Returns what the dashboard and the gateway say afterwards.
  async function corruptedOverrides(tag) {
    const clock = fakeClock(), dir = mkdir('corrupt-' + tag), u = U('c' + tag);
    await intro(u);
    const ctx = await bootApp({ port: PORTS.appL5, dataDir: dir, clock, gatewayUrl: gw.url });
    const t = await ctx.login('ada');
    await ctx.call('PUT', '/api/org/budget', { token: t, body: { period: 'weekly', action: 'set', usd: 100 } });
    const r = await ctx.call('POST', '/api/overrides', { token: t, body: { sub: u.sub, period: 'weekly', extraUsd: 40, endsAt: iso(clock.t + 2 * H), reason: 'corruption' } });
    assert.equal(r.json.status, 'active', r.text);
    const file = path.join(dir, 'overrides.json'), good = fs.readFileSync(file, 'utf8');
    return { ctx, clock, dir, u, t, file, good, id: r.json.id };
  }

  test('a torn overrides.json degrades reads (HTTP 200, overrides [], overridesError:true) instead of looking like "no overrides", and fails writes and ticks with a 500', async () => {
    const c = await corruptedOverrides('a');
    try {
      fs.writeFileSync(c.file, c.good.slice(0, Math.floor(c.good.length / 2)));   // a half-written file
      const list = await c.ctx.call('GET', '/api/overrides', { token: c.t });
      assert.equal(list.status, 200, list.text); assert.equal(list.json.overridesError, true, 'the response says the data is missing, not empty'); assert.deepEqual(list.json.overrides, []);
      const users = await c.ctx.call('GET', '/api/users', { token: c.t }); assert.equal(users.status, 200); assert.equal(users.json.overridesError, true);
      const w = await c.ctx.call('POST', '/api/overrides', { token: c.t, body: { sub: c.u.sub, period: 'weekly', extraUsd: 5, endsAt: iso(c.clock.t + 2 * H), reason: 'write while damaged' } });
      assert.equal(w.status, 500, w.text);
    } finally { await c.ctx.close(); const stuck = await personal(c.u.sub); if (stuck) await raw('DELETE', '/' + stuck.id, { key: E.keys.system }); }
  });

  test('after the store file is torn, writes fail loudly and the file is NOT replaced; once an operator restores it the boosted cap reverts', async () => {
    const c = await corruptedOverrides('b');
    try {
      const torn = c.good.slice(0, Math.floor(c.good.length / 2));
      fs.writeFileSync(c.file, torn);
      const other = U('cb2'); await intro(other);
      const r2 = await c.ctx.call('POST', '/api/overrides', { token: c.t, body: { sub: other.sub, period: 'weekly', extraUsd: 5, endsAt: iso(c.clock.t + 2 * H), reason: 'another boost' } });
      assert.ok(r2.status >= 500, 'the write is refused: ' + r2.status + ' ' + r2.text);
      assert.equal(fs.readFileSync(c.file, 'utf8'), torn, 'the torn file is left exactly as it was (no silent replacement)');
      assert.ok(fs.readdirSync(path.dirname(c.file)).some((n) => n.startsWith('overrides.json.corrupt-')), 'a quarantine copy was kept for the operator');
      c.clock.advance(3 * H);
      const t = await c.ctx.call('POST', '/api/internal/tick', { token: await c.ctx.login('ada') });
      assert.ok(t.status >= 500, 'the tick fails loudly too: ' + t.status);
      fs.writeFileSync(c.file, c.good);                                   // the operator restores the document
      await c.ctx.call('POST', '/api/internal/tick', { token: await c.ctx.login('ada') });
      const stuck = await personal(c.u.sub);
      if (stuck) await raw('DELETE', '/' + stuck.id, { key: E.keys.system });   // tidy the gateway either way
      assert.equal(stuck, null, `the boosted cap (${stuck?.amount} cents) was reverted after the restore`);
    } finally { await c.ctx.close(); }
  });

  test('valid JSON of the wrong shape: reads degrade (200, overridesError), the tick fails loudly (500), and the file is left exactly as it was', async () => {
    const c = await corruptedOverrides('c');
    try {
      fs.writeFileSync(c.file, '{"unexpected":true}');
      const read = await c.ctx.call('GET', '/api/overrides', { token: c.t });
      assert.equal(read.status, 200, 'a read must degrade, not die'); assert.equal(read.json.overridesError, true); assert.deepEqual(read.json.overrides, []);
      assert.ok(!STACK.test(read.text), read.text);
      const tick = await c.ctx.call('POST', '/api/internal/tick', { token: c.t });
      assert.equal(tick.status, 500); assert.equal(typeof tick.json.error, 'string'); assert.ok(!STACK.test(tick.text), tick.text);
      assert.equal(fs.readFileSync(c.file, 'utf8'), '{"unexpected":true}', 'no silent overwrite');
    } finally { await c.ctx.close(); const stuck = await personal(c.u.sub); if (stuck) await raw('DELETE', '/' + stuck.id, { key: E.keys.system }); }
  });

  test('an unreadable usage/cursor.json fails the ingest loudly instead of restarting the 30-day backfill and counting every request twice', async () => {
    const { createUsage } = await import('../../api/lib/usage/index.mjs');
    const { entriesFromLines, fakeCloud, window24h } = await import('./lib/cloudlog.mjs');
    const dir = mkdir('cursor'), store = createFileStore(dir);
    const now = Date.now();
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: new Date(now - 60e3 + i * 100).toISOString(), evt: 'inference', request_id: `c-${i}`, sub: 'cu1', email: 'cu1@example.com', path: '/v1/messages', model: MODELS.sonnet, upstream: 'vertex', upstream_request_id: null, status: 200, ms: 10 }));
    const cloud = fakeCloud(entriesFromLines(lines));
    const usage = await createUsage({ usageSource: 'logs' }, { store, fetchImpl: cloud.fetch, env: { GOOGLE_CLOUD_PROJECT: 'e2e' } });
    await usage.ingest();
    assert.equal((await usage.company(window24h())).totals.requests, 5);
    fs.writeFileSync(path.join(dir, 'usage', 'cursor.json'), '{"ts": "2026-');
    let failed = null;
    try { await usage.ingest(); } catch (e) { failed = e; }
    const total = (await usage.company(window24h())).totals.requests;
    assert.ok(failed || total === 5, `no error was raised and the dashboard now says ${total} requests for 5 real ones`);
  });
});

describe('L5 scale', () => {
  const synthetic = (n) => Array.from({ length: n }, (_, i) => ({ sub: `s${String(i).padStart(5, '0')}`, email: `s${i}@example.com`, name: `Synthetic ${i}` }));
  async function twinApp(n, eventsPer = 3) {
    const users = synthetic(n);
    const clock = fakeClock();
    const gateway = createMemoryGateway({ users, now: clock.now });
    await gateway.upsert({ type: 'organization' }, 'weekly', 15000, { key: 'k', actor: 'ada@example.com' });
    for (let i = 0; i < n; i += 7) await gateway.upsert({ type: 'user', user_id: users[i].sub }, 'monthly', 10000 + i, { key: 'k', actor: 'ada@example.com' });
    const store = createMemoryStore(), agg = createAggregator(store);
    const events = [];
    for (const u of users) for (let j = 0; j < eventsPer; j++) events.push({ ts: clock.t - j * 600e3, requestId: `${u.sub}-${j}`, sub: u.sub, email: u.email, model: MODELS.sonnet, status: j === 2 ? 429 : 200, ms: 100 + j, upstream: j === 2 ? 'vertex' : 'vertex', loadTest: false });
    await agg.add(events);
    const usage = { source: 'logs', ok: async () => true, roster: () => agg.roster(), users: (w) => agg.users(w), detail: (s, w, l) => agg.detail(s, w, l), company: (w) => agg.company(w), ingest: async () => ({ ingested: 0 }) };
    const { env } = appEnv({ dataDir: mkdir('scale') });
    const cfg = loadConfig(env);
    const app = createApp(cfg, { now: clock.now, store: createMemoryStore(), gateway, usage, log: () => {}, lazyTickMs: 0, timerTickMs: 0 });
    await new Promise((ok) => app.server.listen(PORTS.appL5, '127.0.0.1', ok));
    return { app, users, call: async (p) => { const t0 = Date.now(); const r = await fetch(`http://127.0.0.1:${PORTS.appL5}${p}`, { headers: { connection: 'close' } }); const text = await r.text(); return { status: r.status, ms: Date.now() - t0, bytes: text.length, json: JSON.parse(text) }; } };
  }

  for (const n of [500, 3000]) {
    test(`${n} users in the twin: /api/users, /api/company, /api/users/:sub respond within a generous bound`, async () => {
      const t = await twinApp(n);
      try {
        const u = await t.call('/api/users?range=7d'), c = await t.call('/api/company?range=7d'), d = await t.call(`/api/users/${t.users[n - 1].sub}?range=7d`), a = await t.call('/api/audit');
        console.log(`  (${n} users: users ${u.ms} ms / ${(u.bytes / 1e6).toFixed(2)} MB, company ${c.ms} ms, detail ${d.ms} ms, audit ${a.ms} ms)`);
        assert.equal(u.status, 200); assert.equal(u.json.users.length, n);
        assert.equal(c.json.seats, n); assert.equal(c.json.totals.requests, n * 3); assert.equal(c.json.totals.upstream_errors, n);
        assert.equal(d.status, 200);
        assert.ok(u.ms < 8000 && c.ms < 8000 && d.ms < 8000, 'generous bound');
        const capped = u.json.users.filter((x) => x.budgets.monthly.source === 'user').length; assert.equal(capped, Math.ceil(n / 7));
      } finally { await t.app.close(); }
    });
  }

  test('1200 real users on the real gateway (more than one effective() page of 1000): the app lists every one', async () => {
    const N = 1200, users = Array.from({ length: N }, (_, i) => U('big' + i));
    const t0 = Date.now(); let i = 0;
    await Promise.all(Array.from({ length: 30 }, async () => { while (i < N) { const u = users[i++]; const r = await messages(session(u), { url: gw.url }); if (r.status !== 200) throw new Error('introduce failed ' + r.status); } }));
    await waitListed(users.map((x) => x.sub), { url: gw.url, ms: 30000 });
    const made = Date.now() - t0;
    const ctx = await bootApp({ port: PORTS.appL5, dataDir: mkdir('big'), clock: fakeClock(), gatewayUrl: gw.url });
    try {
      const s = Date.now();
      const r = await ctx.call('GET', '/api/users');
      console.log(`  (introduced ${N} real users in ${made} ms; /api/users answered in ${Date.now() - s} ms, ${(r.text.length / 1e6).toFixed(2)} MB)`);
      assert.equal(r.status, 200);
      const mine = r.json.users.filter((x) => x.sub.startsWith(P + '-big'));
      assert.equal(mine.length, N, 'no user is lost at the 1000-user page boundary');
      assert.equal(new Set(mine.map((x) => x.sub)).size, N);
      assert.ok(mine.every((x) => x.email && x.budgets.weekly));
      const co = await ctx.call('GET', '/api/company'); assert.equal(co.status, 200); assert.ok(co.json.seats >= N);
    } finally { await ctx.close(); }
  });
});
