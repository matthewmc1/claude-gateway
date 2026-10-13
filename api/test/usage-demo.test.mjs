import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store.mjs';
import { createAggregator } from '../lib/usage/aggregate.mjs';
import { create } from '../lib/usage/demo.mjs';
import { DEMO_USERS } from '../lib/demo-users.mjs';

const NOW = Date.UTC(2026, 9, 14, 15, 30);                       // a Wednesday afternoon
const END = Math.ceil(NOW / 1000 / 86400) * 86400;
const W = { range: '30d', data: 'all', n: 31, b: 86400, start: END - 31 * 86400, end: END };
const CATALOG = { default: 'sonnet', models: [{ alias: 'sonnet', id: 'claude-sonnet-5-5', tier: 'default' }, { alias: 'opus', id: 'claude-opus-5-5', tier: 'upgrade' }, { alias: 'haiku', id: 'claude-haiku-5-5', tier: 'fast' }] };
const CFG = { demo: true, catalog: CATALOG };

async function make(opts = {}, cfg = CFG) {
  const store = opts.store || createMemoryStore(), aggregator = createAggregator(store, { now: () => opts.now ?? NOW });
  const usage = await create(cfg, { store, aggregator, now: () => opts.now ?? NOW, ...(opts.seed ? { seed: opts.seed } : {}) });
  return { store, aggregator, usage };
}
let shared;
const demo = async () => (shared ||= make());
const by = (rows) => new Map(rows.map((r) => [r.sub, r]));
const errRate = (u) => 1 - u.ok / u.requests;
const sumRows = (rows, f) => rows.filter(f).reduce((a, r) => a + r.n, 0);

test('seeds in well under 1.5 s and reports itself as the demo source', async () => {
  const t = Date.now(); const { usage } = await make({ store: createMemoryStore() }); const ms = Date.now() - t;
  assert.ok(ms < 1500, `seeding took ${ms} ms`);
  assert.equal(usage.source, 'demo'); assert.equal(await usage.ok(), true); assert.deepEqual(await usage.ingest(), { ingested: 0 });
  const c = await usage.company(W); assert.ok(c.totals.requests > 3000, 'a month of traffic for ten people'); assert.equal(c.totals.users, DEMO_USERS.length);
});

test('deterministic: the same seed and clock give identical aggregates; another seed does not', async () => {
  const a = await make(), b = await make(), c = await make({ seed: 'something-else' });
  const snap = async (x) => JSON.stringify([await x.usage.company(W), await x.usage.users(W), ...(await Promise.all(DEMO_USERS.map((u) => x.usage.detail(u.sub, W, 50))))], (k, v) => (v instanceof Map ? [...v] : v));
  assert.equal(await snap(a), await snap(b));
  assert.notEqual(await snap(a), await snap(c));
});

test('roster has everyone, with their demo emails', async () => {
  const { usage } = await demo();
  assert.deepEqual([...(await usage.roster())].sort(), DEMO_USERS.map((u) => [u.sub, u.email]).sort());
});

test('profile: Dara has a high error rate, everyone else stays low, June has none', async () => {
  const { usage } = await demo(); const u = by((await usage.users(W)).rows);
  assert.ok(errRate(u.get('demo-dara')) > 0.12, `dara ${errRate(u.get('demo-dara'))}`);
  for (const x of DEMO_USERS.filter((x) => x.sub !== 'demo-dara')) assert.ok(errRate(u.get(x.sub)) < 0.07, `${x.sub} ${errRate(u.get(x.sub))}`);
  assert.equal(u.get('demo-june').ok, u.get('demo-june').requests);
});

test('profile: Ben is mostly Opus, June never touches it, mixes follow the profile', async () => {
  const { usage } = await demo();
  const share = async (sub, id) => { const d = await usage.detail(sub, W); const t = d.models.reduce((a, m) => a + m.requests, 0); return (d.models.find((m) => m.model === id)?.requests || 0) / t; };
  assert.ok(await share('demo-ben', 'claude-opus-5-5') > 0.6);
  assert.ok(await share('demo-chen', 'claude-sonnet-5-5') > 0.7);
  assert.equal(await share('demo-june', 'claude-opus-5-5'), 0);
  assert.ok(await share('demo-fatima', 'claude-haiku-5-5') > 0.2);
});

test('profile: Eli (at his weekly limit) gets spend-cap blocks in the last day or so, nobody else does', async () => {
  const { usage, aggregator } = await demo(); const rows = await aggregator.rows(W);
  assert.ok(sumRows(rows, (r) => r.sub === 'demo-eli' && r.outcome === 'spend_cap') >= 5);
  assert.equal(sumRows(rows, (r) => r.sub !== 'demo-eli' && r.outcome === 'spend_cap'), 0);
  const d = await usage.detail('demo-eli', W, 500);
  const caps = d.recent.filter((r) => r.outcome === 'spend_cap');
  assert.ok(caps.length >= 5); for (const r of caps) { assert.equal(r.status, 429); assert.equal(r.cause, null); assert.ok(Date.parse(r.ts) >= NOW - 30 * 3600e3); assert.ok(r.model, 'a blocked request still names its model'); }
  assert.ok(caps.length < d.recent.length / 3, 'a few, not most');
});

test('profile: June is quiet; volume follows weight', async () => {
  const { usage } = await demo(); const u = by((await usage.users(W)).rows);
  const others = DEMO_USERS.filter((x) => x.sub !== 'demo-june').map((x) => u.get(x.sub).requests);
  assert.ok(u.get('demo-june').requests > 0 && u.get('demo-june').requests < 0.35 * (others.reduce((a, b) => a + b) / others.length));
  assert.ok(u.get('demo-ada').requests > 2 * u.get('demo-fatima').requests);                       // weight 1.7 vs 0.5
  assert.ok(u.get('demo-ada').requests > u.get('demo-hana').requests);
});

test('profile: traffic follows each person\'s working hours (UTC), and weekdays outweigh weekends', async () => {
  const { aggregator } = await demo(); const rows = (await aggregator.rows(W)).filter((r) => !r.lt);
  for (const x of DEMO_USERS) {
    const mine = rows.filter((r) => r.sub === x.sub), [s, e] = x.profile.hours;
    const inside = mine.filter((r) => { const h = new Date(r.h * 1000).getUTCHours(); return h >= s && h < e + 3; }).reduce((a, r) => a + r.n, 0);
    const all = mine.reduce((a, r) => a + r.n, 0);
    assert.ok(inside / all > 0.995, `${x.sub}: ${inside}/${all}`);
    const core = mine.filter((r) => { const h = new Date(r.h * 1000).getUTCHours(); return h >= s && h < e; }).reduce((a, r) => a + r.n, 0);
    assert.ok(core / all > 0.9, `${x.sub} mostly inside core hours`);
  }
  const perDay = new Map();
  for (const r of rows) { const d = new Date(r.h * 1000).toISOString().slice(0, 10); perDay.set(d, (perDay.get(d) || 0) + r.n); }
  const avg = (f) => { const v = [...perDay].filter(([d]) => f(new Date(d + 'T00:00:00Z').getUTCDay())).map(([, n]) => n); return v.reduce((a, b) => a + b, 0) / v.length; };
  assert.ok(avg((d) => d >= 1 && d <= 5) > 3 * avg((d) => d === 0 || d === 6), 'weekends are light');
});

test('profile: latency is plausible and ordered haiku < sonnet < opus', async () => {
  const { usage } = await demo();
  const d = await usage.detail('demo-ada', W); const p = Object.fromEntries(d.models.map((m) => [m.model, m.p50]));
  assert.ok(p['claude-haiku-5-5'] < p['claude-sonnet-5-5'] && p['claude-sonnet-5-5'] < p['claude-opus-5-5'], JSON.stringify(p));
  assert.ok(p['claude-haiku-5-5'] > 100 && p['claude-opus-5-5'] < 20000);
});

test('profile: provider failures are 429/403 with real-looking causes; policy rejections are 400 with no model', async () => {
  const { usage, aggregator } = await demo();
  const d = await usage.detail('demo-dara', W, 500);
  const up = d.recent.filter((r) => r.outcome === 'upstream_error');
  assert.ok(up.length > 5);
  for (const r of up) { assert.ok([429, 403].includes(r.status)); assert.ok(['RESOURCE_EXHAUSTED', 'PERMISSION_DENIED'].includes(r.cause), r.cause); assert.equal(r.status === 403, r.cause === 'PERMISSION_DENIED'); assert.ok(r.model); }
  assert.ok(up.some((r) => r.cause === 'RESOURCE_EXHAUSTED'));
  for (const r of d.recent.filter((r) => r.outcome === 'ok')) assert.equal(r.cause, null);
  const rows = await aggregator.rows(W), rej = sumRows(rows, (r) => r.outcome === 'rejected'), all = sumRows(rows, () => true);
  assert.ok(rej >= 3 && rej < 0.01 * all, `rejected ${rej} of ${all}`);
  assert.ok(rows.filter((r) => r.outcome === 'rejected').every((r) => r.model === ''));
  const c = await usage.company(W); assert.equal(c.totals.rejected, rej); assert.ok(c.byModel.some((m) => m.model === '(none)'));
});

test('load tests: a handful, flagged, and excluded from the real view', async () => {
  const { usage } = await demo();
  const lt = (await usage.company({ ...W, data: 'loadtest' })).totals, real = (await usage.company({ ...W, data: 'real' })).totals, all = (await usage.company(W)).totals;
  assert.ok(lt.requests >= 10 && lt.requests <= 100); assert.equal(lt.requests + real.requests, all.requests);
  assert.ok(lt.upstream_errors >= 1);
});

test('time: every event is in the past, newest first in recent, nothing older than 30 days', async () => {
  const { usage } = await demo(); const d = await usage.detail('demo-ada', W, 200);
  const ts = d.recent.map((r) => Date.parse(r.ts));
  assert.ok(ts.every((t) => t <= NOW)); assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
  const u = by((await usage.users(W)).rows); assert.ok(Date.parse(u.get('demo-ada').lastSeen) > NOW - 3 * 3600e3);
  const rows = await (await demo()).aggregator.rows(W); assert.ok(Math.min(...rows.map((r) => r.h)) >= NOW / 1000 - 30 * 86400 - 3600);
});

test('catalog: ids come from the configured aliases; aliases the catalog lacks are dropped and the mix renormalised', async () => {
  const cat = { default: 'main', models: [{ alias: 'sonnet', id: 'acme-sonnet-X' }, { alias: 'opus', id: 'acme-opus-X', tier: 'upgrade' }] };
  const { usage } = await make({}, { demo: true, catalog: cat });
  const ids = new Set((await usage.company(W)).byModel.map((m) => m.model));
  assert.deepEqual([...ids].sort(), ['(none)', 'acme-opus-X', 'acme-sonnet-X']);
  const only = await make({}, { demo: true, catalog: { default: 'main', models: [{ alias: 'main', id: 'only-model', tier: 'default' }] } });
  assert.deepEqual((await only.usage.company(W)).byModel.map((m) => m.model).sort(), ['(none)', 'only-model']);
  const empty = await make({}, { demo: true, catalog: { default: undefined, models: [] } });
  assert.ok((await empty.usage.company(W)).totals.requests > 0, 'an empty catalog still produces data');
});

test('seed is idempotent per store; a later clock only adds the missing hours', async () => {
  const store = createMemoryStore();
  const a = await make({ store }); const before = JSON.stringify((await a.usage.company(W)).totals);
  const b = await make({ store }); assert.equal(JSON.stringify((await b.usage.company(W)).totals), before, 'second create adds nothing');
  const later = NOW + 5 * 3600e3;
  const c = await make({ store, now: later }); const t = (await c.usage.company({ ...W, end: W.end + 86400, n: 32 })).totals;
  assert.ok(t.requests > JSON.parse(before).requests);
  const d = await make({ store, now: later }); assert.equal((await d.usage.company({ ...W, end: W.end + 86400, n: 32 })).totals.requests, t.requests);
  // topping up in two steps gives the same traffic as generating to the later instant in one go (a pure function of seed, user and hour)
  const fresh = await make({ now: later }), w2 = { ...W, start: W.start + 86400, end: W.end + 86400, n: 31 };   // from a day both runs cover
  const ada = async (x) => (by((await x.usage.users(w2)).rows).get('demo-ada').requests);
  assert.equal(await ada(c), await ada(fresh));
});

test('the demo store never contains anything outside the fictional cast', async () => {
  const { usage } = await demo(); const subs = (await usage.company(W)).byUser.map((u) => u.sub);
  assert.ok(subs.every((s) => DEMO_USERS.some((u) => u.sub === s)));
  assert.ok((await usage.company(W)).byUser.every((u) => u.email.endsWith('@example.com')));
});
