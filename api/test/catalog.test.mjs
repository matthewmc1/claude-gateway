// The model catalog (config/models.json): Claude 4.6 entries, family/pin rules, validation, the "4.6 as the default" recipe,
// and what the coach, the demo backend and GET /api/models make of it. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, loadCatalog, loadConfig, normalizeCatalog } from '../lib/config.mjs';
import { buildCoach, roleOf } from '../lib/coach.mjs';
import { createMemoryStore } from '../lib/store.mjs';
import { createAggregator } from '../lib/usage/aggregate.mjs';
import { create as createDemo } from '../lib/usage/demo.mjs';
import { createApp } from '../lib/routes.mjs';
import { fakeClock, fakeUsage, memStore, seededGateway, silent, testEnv } from './api-helpers.mjs';

const shipped = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
// The recipe from docs/ARCHITECTURE.md: run 4.6 as the default for everyone.
const recipe = () => {
  const c = shipped(); c.default = 'sonnet-4-6';
  for (const m of c.models) {
    if (m.alias === 'sonnet' || m.alias === 'opus') m.pin = false;
    if (m.alias === 'sonnet-4-6' || m.alias === 'opus-4-6') m.pin = true;
  }
  return c;
};
const edit = (fn) => { const c = shipped(); fn(c); return c; };
const pins = (cat) => Object.fromEntries(cat.models.filter((m) => m.pinned).map((m) => [m.family, m.id]));

test('the shipped catalog has Sonnet 4.6 and Opus 4.6 as "previous" entries that are allowed but not pinned', () => {
  const cat = loadCatalog({});
  assert.equal(cat.default, 'sonnet');
  const s = cat.models.find((m) => m.alias === 'sonnet-4-6'), o = cat.models.find((m) => m.alias === 'opus-4-6');
  assert.deepEqual([s.id, s.label, s.tier, s.family, s.enabled, s.pinned], ['claude-sonnet-4-6', 'Sonnet 4.6', 'previous', 'sonnet', true, false]);
  assert.deepEqual([o.id, o.label, o.tier, o.family, o.enabled, o.pinned], ['claude-opus-4-6', 'Opus 4.6', 'previous', 'opus', true, false]);
  assert.deepEqual(pins(cat), { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' }, 'Defaults stay Sonnet 5.5 / Opus 5.5 / Haiku 5.5');
  assert.deepEqual(s.pricePerMTok, { input: null, output: null, cacheRead: null, cacheWrite: null });
});

test('config/models.json and client/models.json are byte-identical, and the built-in fallback agrees with them', () => {
  assert.ok(fs.readFileSync(path.join(ROOT, 'config', 'models.json')).equals(fs.readFileSync(path.join(ROOT, 'client', 'models.json'))));
  const builtin = loadCatalog({ MODELS_FILE: path.join(ROOT, 'does-not-exist.json') });
  const file = loadCatalog({});
  const brief = (c) => ({ default: c.default, models: c.models.map((m) => [m.alias, m.id, m.label, m.tier, m.family, m.enabled, m.pinned]) });
  assert.deepEqual(brief(builtin), brief(file));
});

test('recipe: 4.6 as the default for everyone moves the default and both pins; every enabled model stays usable', () => {
  const cat = normalizeCatalog(recipe());
  assert.equal(cat.default, 'sonnet-4-6');
  assert.deepEqual(pins(cat), { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', haiku: 'claude-haiku-5-5' });
  assert.equal(cat.models.filter((m) => m.enabled).length, 5);
  assert.equal(cat.models.find((m) => m.alias === 'sonnet').pinned, false);
  // the same through MODELS_JSON, which is how Terraform hands it to the app
  assert.deepEqual(loadConfig(testEnv({ MODELS_JSON: JSON.stringify(recipe()) })).catalog, cat);
});

test('default may be given as an id (normalised to the alias), case-insensitively; omitted means the first enabled entry', () => {
  assert.equal(normalizeCatalog(edit((c) => { c.default = 'claude-opus-4-6'; })).default, 'opus-4-6');
  assert.equal(normalizeCatalog(edit((c) => { c.default = 'SONNET-4-6'; })).default, 'sonnet-4-6');
  assert.equal(normalizeCatalog(edit((c) => { delete c.default; c.models[0].enabled = false; c.models[0].pin = false; })).default, 'opus');
});

test('a disabled entry that would pin by name does not collide with an explicit pin', () => {
  const cat = normalizeCatalog(edit((c) => { c.models[0].enabled = false; c.models.find((m) => m.alias === 'sonnet-4-6').pin = true; c.default = 'sonnet-4-6'; }));
  assert.equal(pins(cat).sonnet, 'claude-sonnet-4-6');
});

test('a custom alias can pin a family when it says which family', () => {
  const cat = normalizeCatalog(edit((c) => { c.models.push({ alias: 'fast-sonnet', id: 'claude-sonnet-x', family: 'sonnet', pin: true }); c.models[0].pin = false; }));
  assert.equal(pins(cat).sonnet, 'claude-sonnet-x');
  assert.throws(() => normalizeCatalog(edit((c) => { c.models.push({ alias: 'mystery', id: 'x-1', pin: true }); })), /pinned but has no family/);
  assert.equal(normalizeCatalog(edit((c) => { c.models.push({ alias: 'mystery', id: 'x-1' }); })).models.at(-1).pinned, false, 'no family and no pin: allowed, not pinned');
});

test('invalid catalogs are refused with a clear message', () => {
  const bad = (fn, re) => assert.throws(() => normalizeCatalog(edit(fn)), re, String(fn));
  bad((c) => { c.models[3].alias = 'sonnet'; }, /aliases must be unique/);
  bad((c) => { c.models[3].alias = 'SONNET'; }, /aliases must be unique/);
  bad((c) => { c.models[3].id = c.models[0].id; }, /ids must be unique/);
  bad((c) => { c.models[3].pin = true; }, /more than one model pins the sonnet family \(sonnet, sonnet-4-6\)/);
  bad((c) => { c.models[3].family = 'opus'; c.models[3].pin = true; c.models[4].pin = true; }, /pins the opus family/);
  bad((c) => { c.default = 'nope'; }, /"default" must be the alias or id/);
  bad((c) => { c.default = 'opus-4-6'; c.models[4].enabled = false; }, /must be enabled/);
  bad((c) => { c.models[3].enabled = false; c.models[3].pin = true; c.models[0].pin = false; }, /pinned but disabled/);
  bad((c) => { c.models[3].family = 'gpt'; }, /"family" must be one of/);
  bad((c) => { c.models[3].family = 5; }, /"family" must be one of/);
  bad((c) => { c.models[3].pin = 'yes'; }, /"pin" must be true or false/);
  bad((c) => { c.models[3].enabled = 'no'; }, /"enabled" must be true or false/);
  bad((c) => { delete c.models[3].id; }, /needs an alias and an id|every model needs/);
  bad((c) => { c.models = []; }, /non-empty "models" list/);
  bad((c) => { for (const m of c.models) m.enabled = false; delete c.default; }, /no enabled models/);
  assert.throws(() => loadCatalog({ MODELS_JSON: '{nope' }), /MODELS_JSON is not valid JSON/);
  assert.throws(() => loadCatalog({ MODELS_JSON: JSON.stringify(edit((c) => { c.models[3].pin = true; })) }), /MODELS_JSON: more than one model pins/, 'the source is named');
  // and the server refuses to start on it (a bad catalog never silently falls back to a different one)
  assert.throws(() => loadConfig(testEnv({ MODELS_JSON: JSON.stringify(edit((c) => { c.models[3].pin = true; })) })), /pins the sonnet family/);
});

test('"default": null or "" is refused like the installer and Terraform do; omitting the key still means the first enabled entry', () => {
  for (const bad of [null, '', ' ', 5, [], {}]) assert.throws(() => normalizeCatalog(edit((c) => { c.default = bad; })), /"default" must be the alias or id/, JSON.stringify(bad));
  assert.equal(normalizeCatalog(edit((c) => { delete c.default; })).default, 'sonnet');
});
test('coach: Opus 4.6 counts as the premium model and Sonnet 4.6 as a default-class one, and the insight names what the person used', () => {
  const cat = normalizeCatalog(shipped());
  assert.deepEqual(cat.models.map(roleOf), ['default', 'upgrade', 'fast', 'default', 'upgrade']);
  const m = (model, requests) => ({ model, requests, ok: requests, p50: 800 });
  const run = (models, catalog = cat) => buildCoach({ user: { sub: 'u1' }, budgets: {}, detail: { models, recent: [] }, range: '7d', catalog, overrides: [], now: Date.parse('2026-03-20T12:00:00Z') });
  const heavy = run([m('claude-opus-4-6', 50), m('claude-sonnet-4-6', 10)]).insights.find((i) => i.id === 'model-upgrade-heavy');
  assert.ok(heavy, 'Opus 4.6 usage triggers the premium-model insight');
  assert.match(heavy.title, /Opus 4\.6/); assert.doesNotMatch(heavy.title, /5\.5/);
  // two premium models in use: the share is the SUM, so the insight names the family and lists the models, never one model's name with the sum
  const mixed = run([m('claude-opus-5-5', 40), m('claude-opus-4-6', 12), m('claude-sonnet-4-6', 4)]).insights.find((i) => i.id === 'model-upgrade-heavy');
  assert.equal(mixed.title, 'Most requests go to Opus models');
  assert.match(mixed.description, /used Opus models \(Opus 5\.5, Opus 4\.6\)/);
  assert.equal(run([m('claude-sonnet-4-6', 40), m('claude-sonnet-5-5', 10)]).insights.find((i) => i.id === 'model-upgrade-heavy'), undefined);
  // under the recipe the default is Sonnet 4.6 and the advice names it
  const rc = normalizeCatalog(recipe());
  assert.match(run([m('claude-opus-4-6', 50), m('claude-sonnet-4-6', 10)], rc).insights.find((i) => i.id === 'model-upgrade-heavy').action, /Sonnet 4\.6/);
});

test('coach: 40 Opus 5.5 + 30 Opus 4.6 + 10 Sonnet 4.6 is 87.5% on Opus models, not "87.5% on Opus 5.5" (true share of 5.5 is 50%)', () => {
  const cat = normalizeCatalog(shipped());
  const m = (model, requests) => ({ model, requests, ok: requests, p50: 800 });
  const c = buildCoach({ user: { sub: 'u1' }, budgets: {}, detail: { models: [m('claude-opus-5-5', 40), m('claude-opus-4-6', 30), m('claude-sonnet-4-6', 10)], recent: [] }, range: '7d', catalog: cat, overrides: [], now: Date.parse('2026-03-20T12:00:00Z') });
  const i = c.insights.find((x) => x.id === 'model-upgrade-heavy');
  assert.match(i.description, /^87\.5% of your 80 requests/);
  assert.equal(i.title, 'Most requests go to Opus models'); assert.doesNotMatch(i.title, /5\.5/);
  assert.match(i.description, /Opus 5\.5, Opus 4\.6/); assert.match(i.action, /^Keep Opus models for hard problems/);
  // one model only keeps its own name
  const one = buildCoach({ user: { sub: 'u1' }, budgets: {}, detail: { models: [m('claude-opus-4-6', 30), m('claude-sonnet-4-6', 10)], recent: [] }, range: '7d', catalog: cat, overrides: [], now: Date.parse('2026-03-20T12:00:00Z') }).insights.find((x) => x.id === 'model-upgrade-heavy');
  assert.equal(one.title, 'Most requests go to Opus 4.6'); assert.match(one.description, /^75% of your 40 requests .* used Opus 4\.6, the premium model\./);
});

async function demoModels(catalog) {
  const NOW = Date.UTC(2026, 9, 14, 15, 30), END = Math.ceil(NOW / 1000 / 86400) * 86400;
  const W = { range: '30d', data: 'all', n: 31, b: 86400, start: END - 31 * 86400, end: END };
  const store = createMemoryStore(), aggregator = createAggregator(store, { now: () => NOW });
  const usage = await createDemo({ demo: true, catalog }, { store, aggregator, now: () => NOW });
  return (await usage.company(W)).byModel.map((m) => m.model).sort();
}

test('demo traffic follows the pins: Sonnet 5.5 normally, 4.6 under the recipe', async () => {
  assert.deepEqual(await demoModels(normalizeCatalog(shipped())), ['(none)', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(await demoModels(normalizeCatalog(recipe())), ['(none)', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6']);
});

test('GET /api/models lists the 4.6 entries with family, pinned and the default', async () => {
  for (const [catalog, def, pinnedIds] of [[shipped(), 'sonnet', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']], [recipe(), 'sonnet-4-6', ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-5-5']]]) {
    const clock = fakeClock();
    const cfg = { ...loadConfig(testEnv({ MODELS_JSON: JSON.stringify(catalog) })), usageSource: 'none' };
    const app = createApp(cfg, { now: clock.now, gateway: await seededGateway(clock), store: memStore(), usage: fakeUsage(), log: silent, lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0 });
    let port = 19170;            // this agent's block is 19100-19179; walk 19170-19179 until one is free
    for (;; port++) {
      try { await new Promise((ok, no) => { app.server.once('error', no); app.server.listen(port, '127.0.0.1', () => { app.server.off('error', no); ok(); }); }); break; }
      catch (e) { if (e.code !== 'EADDRINUSE' || port >= 19179) throw e; }
    }
    try {
      const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/models', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t))); }).on('error', reject));
      assert.equal(body.default, def);
      assert.deepEqual(body.models.map((m) => m.alias), ['sonnet', 'opus', 'haiku', 'sonnet-4-6', 'opus-4-6']);
      assert.deepEqual(body.models.filter((m) => m.pinned).map((m) => m.id).sort(), [...pinnedIds].sort());
      const s46 = body.models.find((m) => m.alias === 'sonnet-4-6');
      assert.equal(s46.tier, 'previous'); assert.equal(s46.family, 'sonnet'); assert.equal(s46.label, 'Sonnet 4.6');
    } finally { await app.close(); }
  }
});

test('warning (not an error) when an enabled family entry exists but nothing pins that family; surfaced on GET /api/models', async () => {
  const none = normalizeCatalog(shipped()); assert.deepEqual(none.warnings, [], 'the shipped catalog and the full recipe pin every family');
  assert.deepEqual(normalizeCatalog(recipe()).warnings, []);
  // half-applied recipe: pin forgotten on the 4.6 entry after the 5.5 entry was un-pinned
  const half = normalizeCatalog(edit((c) => { c.default = 'sonnet-4-6'; c.models.find((m) => m.alias === 'sonnet').pin = false; }));
  assert.equal(half.warnings.length, 1); assert.match(half.warnings[0], /No enabled model pins the sonnet family: sonnet, sonnet-4-6 are available by name/); assert.match(half.warnings[0], /"pin": true/);
  assert.equal(half.default, 'sonnet-4-6', 'still valid: a warning, not a refusal');
  assert.equal(normalizeCatalog(edit((c) => { for (const m of c.models) if (m.family === 'opus' || m.alias === 'opus') m.pin = false; })).warnings.length, 1);
  // a family with no ENABLED entry has nothing to pin: no warning
  assert.deepEqual(normalizeCatalog(edit((c) => { for (const m of c.models) if (m.alias === 'haiku') { m.enabled = false; m.pin = false; } })).warnings, []);
  assert.equal(normalizeCatalog(edit((c) => { for (const m of c.models) if (m.alias !== 'haiku') { m.pin = false; } c.default = 'haiku'; })).warnings.length, 2, 'two families unpinned: two warnings');
  const clock = fakeClock();
  const cfg = { ...loadConfig(testEnv({ MODELS_JSON: JSON.stringify(edit((c) => { c.models.find((m) => m.alias === 'opus').pin = false; })) })), usageSource: 'none' };
  const app = createApp(cfg, { now: clock.now, gateway: await seededGateway(clock), store: memStore(), usage: fakeUsage(), log: silent, lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0 });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  try {
    const get = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/api/models', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t))); }).on('error', reject));
    const body = await get();
    assert.equal(body.warnings.length, 1); assert.match(body.warnings[0], /opus family/);
  } finally { await app.close(); }
  const ok = createApp({ ...loadConfig(testEnv()), usageSource: 'none' }, { now: clock.now, gateway: await seededGateway(clock), store: memStore(), usage: fakeUsage(), log: silent, lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0 });
  await new Promise((r) => ok.server.listen(0, '127.0.0.1', r));
  try {
    const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: ok.server.address().port, path: '/api/models', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t))); }).on('error', reject));
    assert.deepEqual(body.warnings, [], 'always present, empty when fine');
  } finally { await ok.close(); }
});
