import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGoogle, signJwt } from './security-fixtures.mjs';
import { createApp, createDemoGateway, buildDeps } from '../lib/routes.mjs';
import { loadConfig } from '../lib/config.mjs';
import { DEMO_ADMIN, DEMO_USERS } from '../lib/demo-users.mjs';
import { D, H, SECRETS, effAmount, fakeClock, fakeUsage, isoAt, memStore, personal, seededGateway, silent, testCfg } from './api-helpers.mjs';

let nextPort = 19110 + (process.pid % 15);
// Parallel test runs (or other agents' suites) may hold a port: walk the 19110-19149 block until one is free.
async function listenFree(server) {
  for (let tries = 0; tries < 40; tries++) {
    const port = nextPort; nextPort = nextPort >= 19149 ? 19110 : nextPort + 1;
    try { await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); ok(); }); }); return port; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free test port in 19110-19149');
}
const closers = [];
after(async () => { for (const c of closers) await c(); });

function defaultUsage(clock) {
  const rec = (outcome, i) => ({ ts: new Date(clock.t - i * 60e3).toISOString(), id: 'req' + i, sub: 'u1', email: 'u1@example.com', model: 'claude-opus-5-5', outcome, status: outcome === 'ok' ? 200 : 429, ms: 700, lt: false, cause: null });
  return fakeUsage({
    roster: new Map([['u1', 'u1@example.com'], ['u2', 'u2@example.com']]),
    users: [{ sub: 'u1', email: 'u1@example.com', requests: 60, ok: 58, lastSeen: new Date(clock.t - 60e3).toISOString(), models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }],
    detail: { u1: { series: { models: ['claude-opus-5-5'], values: { 'claude-opus-5-5': [1, 2] } }, models: [{ model: 'claude-opus-5-5', requests: 50, ok: 48, p50: 700 }, { model: 'claude-sonnet-5-5', requests: 10, ok: 10, p50: 500 }], recent: [rec('spend_cap', 0), rec('ok', 1)] } },
    company: { totals: { requests: 60, ok: 58, upstream_errors: 0, blocked: 2, rejected: 0, users: 1 }, byUser: [{ sub: 'u1', email: 'u1@example.com', requests: 60 }], byModel: [{ model: 'claude-opus-5-5', requests: 50, ok: 48 }], series: { u1: [1, 2] } },
  });
}

async function boot({ env = {}, cfg: cfgPatch = {}, deps = {}, gateway, usage } = {}) {
  const clock = fakeClock();
  const gw = gateway || await seededGateway(clock);
  const store = memStore();
  const cfg = testCfg(env, cfgPatch);
  const app = createApp(cfg, { now: clock.now, gateway: gw, store, usage: usage || defaultUsage(clock), log: silent, lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0, ...deps });
  const port = await listenFree(app.server);
  closers.push(() => app.close());
  const call = (method, p, { body, raw, token, headers = {}, chunks } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { ...(payload !== undefined && !chunks ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(token ? { 'x-app-token': token } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text: t, json }); });
    });
    req.on('error', reject);
    if (chunks) { for (const c of chunks) req.write(c); req.end(); } else req.end(payload);
  });
  const login = async (email = 'ada@example.com', password = SECRETS.adaPw) => (await call('POST', '/api/login', { body: { email, password } })).json?.token;
  return { app, clock, gw, store, port, call, login, cfg };
}

// ---------- reads ----------
test('open reads need no session and have the documented shapes', async () => {
  const s = await boot();
  const health = await s.call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { gateway: true, usage: { source: 'demo', ok: true }, demo: false, accounts: true, viewAccess: 'open', maxOverrideDays: 90, admin: null, auth: 'session', identity: null });

  const users = (await s.call('GET', '/api/users?range=7d')).json;
  assert.equal(users.range, '7d'); assert.equal(users.data, 'all'); assert.equal(users.demo, false); assert.deepEqual(users.usage, { source: 'demo', ok: true });
  assert.equal(users.buckets.length, 28); assert.equal(users.users.length, 3, 'roster of the gateway plus usage, one row each');
  const u1 = users.users.find((u) => u.sub === 'u1');
  assert.equal(u1.requests, 60); assert.equal(u1.failed, 2); assert.equal(u1.name, 'User One'); assert.equal(u1.spark.length, 28);
  assert.deepEqual(u1.budgets.weekly, { capCents: 15000, spendCents: 0, source: 'organization', limitId: u1.budgets.weekly.limitId, unlimited: false });
  assert.deepEqual(u1.overrides, []);
  assert.equal(users.users[0].sub, 'u1', 'busiest first');
  for (const [range, n] of [['24h', 24], ['30d', 30]]) assert.equal((await s.call('GET', `/api/users?range=${range}`)).json.buckets.length, n);

  const d = (await s.call('GET', '/api/users/u1?range=7d')).json;
  assert.equal(d.user.email, 'u1@example.com'); assert.deepEqual(d.orgDefaults, { weekly: 15000, monthly: 50000 });
  assert.equal(d.bucketSeconds, 21600); assert.equal(d.models.length, 2); assert.equal(d.recent.length, 2); assert.deepEqual(d.overrides, []); assert.deepEqual(d.audit, []);
  assert.ok(d.coach.summary); assert.ok(d.coach.insights.some((i) => i.id === 'telemetry-unavailable'));
  assert.ok(d.coach.insights.some((i) => i.id === 'model-upgrade-heavy'), 'coach sees the real model mix');
  assert.ok(d.coach.insights.some((i) => i.id === 'reliability-spend-cap'));

  const c = (await s.call('GET', '/api/company')).json;
  assert.equal(c.totals.requests, 60); assert.equal(c.seats, 3); assert.deepEqual(c.overrides, { active: 0, scheduled: 0, overdue: 0 });
  assert.equal(c.org.weekly.amountCents, 15000); assert.equal(c.spend.weekly.uncappedUsers, 0); assert.equal(c.spend.weekly.committedCents, 45000);
  assert.deepEqual(c.series.u1, [1, 2]);

  const m = (await s.call('GET', '/api/models')).json;
  assert.equal(m.default, 'sonnet'); assert.equal(m.models.length, 3); assert.deepEqual(m.usage, [{ model: 'claude-opus-5-5', requests: 50, ok: 48 }]);
  assert.deepEqual((await s.call('GET', '/api/overrides')).json.overrides, []);
  assert.deepEqual((await s.call('GET', '/api/audit')).json.events.length, 2, 'seed events from the two org defaults');
});

test('APP_VIEW_ACCESS=admin: reads need a session, health does not and reports who is signed in', async () => {
  const s = await boot({ env: { APP_VIEW_ACCESS: 'admin' } });
  for (const p of ['/api/users', '/api/users/u1', '/api/company', '/api/models', '/api/overrides', '/api/audit']) {
    const r = await s.call('GET', p); assert.equal(r.status, 401, p); assert.deepEqual(r.json, { error: 'sign in required' });
  }
  const h = await s.call('GET', '/api/health'); assert.equal(h.status, 200); assert.equal(h.json.viewAccess, 'admin'); assert.equal(h.json.admin, null);
  const token = await s.login();
  for (const p of ['/api/users', '/api/users/u1', '/api/company', '/api/models', '/api/overrides', '/api/audit']) assert.equal((await s.call('GET', p, { token })).status, 200, p);
  assert.deepEqual((await s.call('GET', '/api/health', { token })).json.admin, { email: 'ada@example.com', name: 'Ada Admin' });
  assert.equal((await s.call('GET', '/api/users', { token: token + 'x' })).status, 401);
});

// ---------- writes ----------
test('every write is 401 without a valid session, and nothing changes', async () => {
  const s = await boot();
  const before = (await s.gw.audit(100)).length;
  const attempts = [
    ['PUT', '/api/users/u1/budget', { period: 'weekly', action: 'set', usd: 10 }], ['PUT', '/api/org/budget', { period: 'weekly', action: 'set', usd: 10 }],
    ['POST', '/api/overrides', { sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(s.clock, 5 * H), reason: 'nope' }],
    ['DELETE', '/api/overrides/ovr_aaaaaaaaaaaa'], ['POST', '/api/internal/tick', {}],
  ];
  for (const [method, p, body] of attempts) {
    for (const token of [undefined, 'garbage', 'a.b']) {
      const r = await s.call(method, p, { body, token }); assert.equal(r.status, 401, `${method} ${p}`); assert.deepEqual(r.json, { error: 'sign in required' });
    }
  }
  assert.equal((await s.gw.audit(100)).length, before);
});

test('login: ok, wrong password and unknown email are indistinguishable, throttled', async () => {
  const s = await boot();
  const ok = await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } });
  assert.equal(ok.status, 200); assert.deepEqual(Object.keys(ok.json).sort(), ['email', 'name', 'token']);
  const wrong = await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: 'nope' } });
  const ghost = await s.call('POST', '/api/login', { body: { email: 'nobody@example.com', password: 'nope' } });
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.json, ghost.json); assert.equal(wrong.text, ghost.text);
  // made-up emails and email-less attempts are throttled on their own and never lock a real account
  for (let i = 0; i < 3; i++) await s.call('POST', '/api/login', { body: { password: 'x' } });
  assert.equal((await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: 'nope' + i } })).status, 401);
  const locked = await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } });
  assert.equal(locked.status, 429); assert.ok(Number(locked.headers['retry-after']) > 0);
  s.clock.advance(61e3);
  assert.equal((await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } })).status, 200);
  assert.equal((await s.call('POST', '/api/login', { raw: '{nope' })).status, 400);
});

test('budget writes: set, unlimited and inherit land in the gateway and the audit trail names the admin', async () => {
  const s = await boot();
  const ada = await s.login('ada@example.com', SECRETS.adaPw), bob = await s.login('bob@example.com', SECRETS.bobPw);
  let r = await s.call('PUT', '/api/users/u1/budget', { token: ada, body: { period: 'weekly', action: 'set', usd: 250.5 } });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.limit.amount, '25050');
  assert.equal(personal(s.gw, 'u1', 'weekly').amount, '25050'); assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '25050');

  r = await s.call('PUT', '/api/users/u1/budget', { token: bob, body: { period: 'monthly', action: 'unlimited' } });
  assert.equal(r.status, 200); assert.equal(personal(s.gw, 'u1', 'monthly').amount, null); assert.equal(await effAmount(s.gw, 'u1', 'monthly'), null);
  const view = (await s.call('GET', '/api/users/u1')).json.user.budgets.monthly;
  assert.deepEqual([view.capCents, view.unlimited, view.source], [null, true, 'user']);

  r = await s.call('PUT', '/api/users/u1/budget', { token: ada, body: { period: 'weekly', action: 'inherit' } });
  assert.deepEqual(r.json, { ok: true, removed: true }); assert.equal(personal(s.gw, 'u1', 'weekly'), null); assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '15000');
  r = await s.call('PUT', '/api/users/u1/budget', { token: ada, body: { period: 'weekly', action: 'inherit' } });
  assert.deepEqual(r.json, { ok: true, removed: false }, 'inherit twice is harmless');

  r = await s.call('PUT', '/api/org/budget', { token: bob, body: { period: 'monthly', action: 'set', usd: 700 } });
  assert.equal(r.status, 200); assert.equal(await effAmount(s.gw, 'u2', 'monthly'), '70000');
  assert.equal((await s.call('PUT', '/api/org/budget', { token: bob, body: { period: 'monthly', action: 'unlimited' } })).status, 400);

  const events = (await s.call('GET', '/api/audit')).json.events;
  const mine = events.filter((e) => e.sub === 'u1' || e.scopeType === 'organization').slice(0, 5).map((e) => [e.actor, e.kind, e.period, e.who]);
  assert.deepEqual(mine, [
    ['bob@example.com', 'raised', 'monthly', 'Everyone (default)'],
    ['ada@example.com', 'removed', 'weekly', 'u1@example.com'],
    ['bob@example.com', 'unlimited', 'monthly', 'u1@example.com'],
    ['ada@example.com', 'created', 'weekly', 'u1@example.com'],
    ['seed', 'created', 'monthly', 'Everyone (default)'],
  ]);
  const detailAudit = (await s.call('GET', '/api/users/u1')).json.audit;
  assert.equal(detailAudit.length, 3); assert.equal(detailAudit[0].actor, 'ada@example.com');
  assert.equal((await s.call('GET', '/api/audit?limit=2')).json.events.length, 2);
  assert.equal((await s.call('GET', '/api/audit?limit=abc')).status, 200);
});

test('local single-admin mode: writes use the shared key and show as local-admin', async () => {
  const s = await boot({ env: { APP_ADMINS: '', APP_ADMIN_PASSWORD: SECRETS.localPw, GATEWAY_ADMIN_WRITE_KEY: SECRETS.localKey } });
  const h = (await s.call('GET', '/api/health')).json; assert.equal(h.accounts, false);
  const token = (await s.call('POST', '/api/login', { body: { password: SECRETS.localPw } })).json.token;
  await s.call('PUT', '/api/users/u2/budget', { token, body: { period: 'weekly', action: 'set', usd: 1 } });
  assert.equal((await s.gw.audit(1))[0].actor, 'admin-key:local-admin');
});

// ---------- overrides over HTTP ----------
test('override through the API: scheduled, applied by the tick, reverted by the tick, visible everywhere', async () => {
  const s = await boot();
  let token = await s.login();
  const body = { sub: 'u1', period: 'weekly', extraUsd: 75, startsAt: isoAt(s.clock, 2 * H), endsAt: isoAt(s.clock, 50 * H), reason: 'launch week' };
  const created = await s.call('POST', '/api/overrides', { token, body });
  assert.equal(created.status, 201); assert.equal(created.json.status, 'scheduled'); assert.equal(created.json.createdBy, 'ada@example.com');
  const id = created.json.id;
  assert.equal((await s.call('POST', '/api/overrides', { token, body: { ...body, startsAt: isoAt(s.clock, 3 * H) } })).status, 409);

  assert.deepEqual((await s.call('GET', '/api/overrides?status=scheduled,active')).json.overrides.map((o) => o.id), [id]);
  assert.deepEqual((await s.call('GET', '/api/overrides?status=ended')).json.overrides, []);
  assert.equal((await s.call('GET', '/api/overrides?status=bogus')).status, 400);
  assert.equal((await s.call('GET', '/api/users')).json.users.find((u) => u.sub === 'u1').overrides[0].id, id);
  assert.deepEqual((await s.call('GET', '/api/company')).json.overrides, { active: 0, scheduled: 1, overdue: 0 });
  assert.equal((await s.call('GET', '/api/users/u1')).json.overrides[0].status, 'scheduled');

  let t = await s.call('POST', '/api/internal/tick', { token, body: {} });
  assert.deepEqual(t.json, { overrides: { applied: 0, ended: 0, failed: 0 }, usage: { ingested: 3 } });

  s.clock.advance(3 * H);
  t = await s.call('POST', '/api/internal/tick', { token });
  assert.deepEqual(t.json.overrides, { applied: 1, ended: 0, failed: 0 });
  assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '22500');
  assert.equal((await s.call('GET', '/api/users/u1')).json.user.budgets.weekly.capCents, 22500);
  assert.deepEqual((await s.call('GET', '/api/company')).json.overrides, { active: 1, scheduled: 0, overdue: 0 });
  const ev = (await s.call('GET', '/api/audit')).json.events[0]; assert.equal(ev.actor, 'system:overrides'); assert.equal(ev.kind, 'created');
  assert.deepEqual((await s.call('POST', '/api/internal/tick', { token })).json.overrides, { applied: 0, ended: 0, failed: 0 }, 'idempotent');

  s.clock.advance(48 * H);
  token = await s.login();                                  // the 12h session expired with the fake clock
  assert.deepEqual((await s.call('POST', '/api/internal/tick', { token })).json.overrides, { applied: 0, ended: 1, failed: 0 });
  assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '15000');
  assert.equal((await s.call('GET', '/api/overrides?status=ended')).json.overrides[0].id, id);

  // cancelling an active boost over HTTP reverts it
  const second = (await s.call('POST', '/api/overrides', { token, body: { ...body, startsAt: undefined, endsAt: isoAt(s.clock, 5 * H), reason: 'incident' } })).json;
  assert.equal(second.status, 'active'); assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '22500');
  const del = await s.call('DELETE', `/api/overrides/${second.id}`, { token });
  assert.equal(del.status, 200); assert.equal(del.json.status, 'cancelled'); assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '15000');
  assert.equal((await s.call('DELETE', `/api/overrides/${second.id}`, { token })).status, 409);
});

test('a manual budget edit through the API supersedes an active boost immediately', async () => {
  const s = await boot(); const token = await s.login();
  const o = (await s.call('POST', '/api/overrides', { token, body: { sub: 'u2', period: 'monthly', extraUsd: 10, endsAt: isoAt(s.clock, 5 * H), reason: 'temp bump' } })).json;
  assert.equal(o.status, 'active');
  await s.call('PUT', '/api/users/u2/budget', { token, body: { period: 'monthly', action: 'set', usd: 123 } });
  assert.equal((await s.call('GET', '/api/overrides')).json.overrides[0].status, 'superseded');
  s.clock.advance(6 * H); await s.call('POST', '/api/internal/tick', { token });
  assert.equal(await effAmount(s.gw, 'u2', 'monthly'), '12300');
});

test('scheduler identity: a Google-signed ID token is accepted on Cloud Run only, and only for SCHEDULER_SA and our audience', async () => {
  const google = fakeGoogle();
  const s = await boot({ cfg: { inCloud: true }, deps: { fetch: google.fetch } });
  const g = (claims, opts) => ({ headers: { authorization: 'Bearer ' + signJwt(s.clock, claims, opts) } });
  const ok = await s.call('POST', '/api/internal/tick', g({})); assert.equal(ok.status, 200); assert.ok(ok.json.overrides);
  for (const bad of [{ email: 'evil@x.iam.gserviceaccount.com' }, { email_verified: false }, { exp: 1 }, { iss: 'x' }, { aud: 'https://elsewhere.run.app' }]) assert.equal((await s.call('POST', '/api/internal/tick', g(bad))).status, 401);
  assert.equal((await s.call('POST', '/api/internal/tick', { headers: { authorization: 'Bearer ' + signJwt(s.clock).replace(/\.[^.]+$/, '.c2ln') } })).status, 401, 'unsigned claims are not enough');
  assert.equal((await s.call('POST', '/api/internal/tick', {})).status, 401);
  assert.equal((await s.call('PUT', '/api/org/budget', { ...g({}), body: { period: 'weekly', action: 'set', usd: 1 } })).status, 401, 'a scheduler token is not an admin');
  const local = await boot({ cfg: { inCloud: false }, deps: { fetch: google.fetch } });
  assert.equal((await local.call('POST', '/api/internal/tick', { headers: { authorization: 'Bearer ' + signJwt(local.clock) } })).status, 401);
  const nosa = await boot({ cfg: { inCloud: true, schedulerSa: '' }, deps: { fetch: google.fetch } });
  assert.equal((await nosa.call('POST', '/api/internal/tick', { headers: { authorization: 'Bearer ' + signJwt(nosa.clock, { email: '' }) } })).status, 401);
});

// ---------- transport guards ----------
test('host guard, origin guard, CORS and security headers', async () => {
  const s = await boot({ env: { APP_DEV: '1' }, cfg: { allowedHostSuffixes: ['.run.app'], allowedOrigins: new Set(['https://app.example.org']) } });
  const own = `127.0.0.1:${s.port}`;
  for (const host of ['evil.example.com', 'evil.example.com:80', 'localhost.evil.com', '127.0.0.1.evil.com']) {
    const r = await s.call('GET', '/api/health', { headers: { host } }); assert.equal(r.status, 400, `host ${host}`); assert.deepEqual(r.json, { error: 'bad host' });
  }
  assert.equal((await s.call('GET', '/api/health', { headers: { host: 'localhost:1234' } })).status, 200);
  assert.equal((await s.call('GET', '/api/health', { headers: { host: 'my-app-abc.a.run.app' } })).status, 200);
  assert.equal((await s.call('GET', '/', { headers: { host: 'evil.example.com' } })).status, 400, 'static files are guarded too');

  assert.equal((await s.call('GET', '/api/users', { headers: { origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await s.call('POST', '/api/login', { headers: { origin: 'http://localhost:9999' }, body: {} })).status, 403);
  assert.equal((await s.call('GET', '/api/users', { headers: { origin: `http://${own}` } })).status, 200);
  assert.equal((await s.call('GET', '/api/users', { headers: { origin: 'https://app.example.org' } })).status, 200);
  const dev = await s.call('GET', '/api/users', { headers: { origin: 'http://localhost:8081' } });
  assert.equal(dev.status, 200); assert.equal(dev.headers['access-control-allow-origin'], 'http://localhost:8081'); assert.equal(dev.headers.vary, 'origin');
  const other = await s.call('GET', '/api/users', { headers: { origin: 'https://app.example.org' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined, 'only dev origins get CORS headers');
  const pre = await s.call('OPTIONS', '/api/overrides', { headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'DELETE' } });
  assert.equal(pre.status, 204); assert.match(pre.headers['access-control-allow-methods'], /DELETE/); assert.match(pre.headers['access-control-allow-headers'], /x-app-token/);

  const r = await s.call('GET', '/api/users');
  assert.equal(r.headers['content-type'], 'application/json'); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  const err = await s.call('GET', '/api/nope'); assert.equal(err.headers['x-content-type-options'], 'nosniff');
});

test('static files: served with the strict CSP, SPA fallback, no traversal, GET only', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>'); fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
  const s = await boot({ cfg: { dist } });
  const idx = await s.call('GET', '/'); assert.equal(idx.status, 200); assert.match(idx.headers['content-type'], /text\/html/);
  assert.match(idx.headers['content-security-policy'], /default-src 'self'/); assert.equal(idx.headers['x-frame-options'], 'DENY');
  assert.equal((await s.call('GET', '/app.js')).headers['content-type'], 'text/javascript');
  assert.match((await s.call('GET', '/some/client/route')).text, /<title>x/, 'SPA fallback');
  for (const p of ['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/a/../../x', '/%00', '/%zz']) { const r = await s.call('GET', p); assert.ok([200, 400].includes(r.status), p); assert.doesNotMatch(r.text, /root:/); }
  assert.equal((await s.call('POST', '/', { body: {} })).status, 405);
  const missing = await boot({ cfg: { dist: path.join(dist, 'nope') } });
  assert.equal((await missing.call('GET', '/')).status, 503);
});

// ---------- bad input ----------
test('bad input matrix for budgets', async () => {
  const s = await boot(); const token = await s.login();
  const put = (p, body, raw) => s.call('PUT', p, { token, body, raw });
  const before = (await s.gw.audit(100)).length;
  const bad = [
    { period: 'weekly', action: 'set', usd: -1 }, { period: 'weekly', action: 'set', usd: 100000.01 }, { period: 'weekly', action: 'set', usd: 1e12 },
    { period: 'weekly', action: 'set', usd: 'abc' }, { period: 'weekly', action: 'set', usd: 'NaN' }, { period: 'weekly', action: 'set', usd: 'Infinity' },
    { period: 'weekly', action: 'set', usd: '' }, { period: 'weekly', action: 'set', usd: null }, { period: 'weekly', action: 'set' }, { period: 'weekly', action: 'set', usd: [5] },
    { period: 'weekly', action: 'set', usd: true }, { period: 'weekly', action: 'set', usd: {} },
    { period: 'weekly', action: 'set', usd: '0x10' }, { period: 'weekly', action: 'set', usd: '1e3' }, { period: 'weekly', action: 'set', usd: 1e3 / 1e9 }, { period: 'weekly', action: 'set', usd: ' ' },
    { period: 'weekly', action: 'set', usd: ' 5' }, { period: 'weekly', action: 'set', usd: '5 ' }, { period: 'weekly', action: 'set', usd: '12.345' }, { period: 'weekly', action: 'set', usd: 0.004 },
    { period: 'weekly', action: 'set', usd: 1.005 }, { period: 'weekly', action: 'set', usd: '-0' }, { period: 'weekly', action: 'set', usd: '+5' }, { period: 'weekly', action: 'set', usd: '5.' },
    { period: 'weekly', action: 'set', usd: '.5' }, { period: 'weekly', action: 'set', usd: '1,5' }, { period: 'weekly', action: 'set', usd: ['5'] },
    { period: 'daily', action: 'set', usd: 5 }, { period: 'yearly', action: 'inherit' }, { action: 'inherit' }, { period: ['weekly'], action: 'inherit' },
    { period: 'weekly', action: 'delete' }, { period: 'weekly', action: 'SET', usd: 5 }, { period: 'weekly' }, { period: 'weekly', action: ['set'], usd: 5 }, {},
  ];
  for (const b of bad) { const r = await put('/api/users/u1/budget', b); assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(typeof r.json.error, 'string'); }
  for (const b of bad.slice(0, 5)) assert.equal((await put('/api/org/budget', b)).status, 400);
  for (const sub of ['bad%20sub', 'a%2Fb', 'x'.repeat(201), '%E0%A4%A', '..']) { const r = await put(`/api/users/${sub}/budget`, { period: 'weekly', action: 'inherit' }); assert.ok([400, 404].includes(r.status), sub); }
  assert.equal((await put('/api/users/u1/budget', undefined, '{"period":')).status, 400);
  assert.equal((await put('/api/users/u1/budget', undefined, 'not json')).status, 400);
  assert.equal((await put('/api/users/u1/budget', undefined, '[1,2]')).status, 400);
  assert.equal((await put('/api/users/u1/budget', undefined, 'null')).status, 400);
  assert.equal((await put('/api/users/u1/budget', undefined, '"str"')).status, 400);
  assert.equal((await s.gw.audit(100)).length, before, 'nothing was written');
  // edge values that are valid
  for (const [usd, cents] of [[0, '0'], ['12.34', '1234'], ['12.50', '1250'], [12.5, '1250'], [100000, '10000000'], ['7', '700'], [0.01, '1'], [0.29, '29'], ['5.000', '500']]) {
    const r = await put('/api/users/u3/budget', { period: 'weekly', action: 'set', usd }); assert.equal(r.status, 200, String(usd)); assert.equal(r.json.limit.amount, cents);
  }
});

test('bad input matrix for overrides and queries', async () => {
  const s = await boot(); const token = await s.login();
  const ok = { sub: 'u1', period: 'weekly', extraUsd: 10, endsAt: isoAt(s.clock, 5 * H), reason: 'valid reason' };
  const post = (b, raw) => s.call('POST', '/api/overrides', { token, body: b, raw });
  for (const patch of [{ sub: 5 }, { sub: '../x' }, { sub: undefined }, { period: 'daily' }, { extraUsd: -1 }, { extraUsd: 0 }, { extraUsd: 'lots' }, { extraUsd: 1e9 }, { extraUsd: null },
    { reason: '' }, { reason: 'ab' }, { reason: 'r'.repeat(201) }, { endsAt: 'soon' }, { endsAt: undefined }, { endsAt: isoAt(s.clock, -H) }, { endsAt: isoAt(s.clock, 10 * 60e3) },
    { endsAt: isoAt(s.clock, 100 * D) }, { startsAt: 'later' }, { startsAt: isoAt(s.clock, 6 * H) }]) {
    const r = await post({ ...ok, ...patch }); assert.equal(r.status, 400, JSON.stringify(patch)); assert.equal(typeof r.json.error, 'string');
  }
  assert.equal((await post(undefined, '[]')).status, 400);
  assert.equal((await post(undefined, '{bad')).status, 400);
  assert.equal((await post({ ...ok, sub: 'ghost-user' })).status, 404, 'unknown user');
  assert.equal((await s.call('GET', '/api/overrides')).json.overrides.length, 0);

  for (const q of ['range=1y', 'range=', 'range=7d&data=bogus', 'data=x']) for (const p of ['/api/users', '/api/company', '/api/models', '/api/users/u1']) assert.equal((await s.call('GET', `${p}?${q}`)).status, 400, `${p}?${q}`);
  for (const data of ['all', 'real', 'loadtest']) assert.equal((await s.call('GET', `/api/users?data=${data}`)).json.data, data);
});

test('bodies over 20KB are refused with 413, content-length and chunked alike, and the server keeps working', async () => {
  const s = await boot(); const token = await s.login();
  const big = JSON.stringify({ period: 'weekly', action: 'set', usd: 5, pad: 'x'.repeat(25000) });
  const r = await s.call('PUT', '/api/users/u1/budget', { token, raw: big });
  assert.equal(r.status, 413); assert.deepEqual(r.json, { error: 'request body too large' });
  const c = await s.call('PUT', '/api/users/u1/budget', { token, chunks: [big.slice(0, 12000), big.slice(12000)], headers: {} });
  assert.equal(c.status, 413);
  const l = await s.call('POST', '/api/login', { raw: big }); assert.equal(l.status, 413);
  assert.equal(personal(s.gw, 'u1', 'weekly'), null);
  const almost = JSON.stringify({ period: 'weekly', action: 'set', usd: 5, pad: 'x'.repeat(15000) });
  assert.equal((await s.call('PUT', '/api/users/u1/budget', { token, raw: almost })).status, 200, 'under the limit is fine');
  assert.equal((await s.call('GET', '/api/health')).status, 200);
});

test('404s and wrong methods are uniform JSON', async () => {
  const s = await boot(); const token = await s.login();
  for (const [m, p] of [['GET', '/api/nope'], ['GET', '/api/'], ['POST', '/api/users'], ['DELETE', '/api/users/u1'], ['GET', '/api/users/u1/budget'], ['PUT', '/api/overrides'], ['GET', '/api/internal/tick'], ['DELETE', '/api/overrides'], ['POST', '/api/health']]) {
    const r = await s.call(m, p, { token }); assert.equal(r.status, 404, `${m} ${p}`); assert.deepEqual(r.json, { error: 'not found' });
  }
  const r = await s.call('GET', '/api/users/ghost'); assert.equal(r.status, 404); assert.deepEqual(r.json, { error: 'unknown user' });
  assert.equal((await s.call('GET', '/api/users/bad%20sub')).status, 400);
  assert.equal((await s.call('GET', '/api/users/%E0%A4%A')).status, 400);
  assert.equal((await s.call('DELETE', '/api/overrides/ovr_aaaaaaaaaaaa', { token })).status, 404);
  assert.equal((await s.call('DELETE', '/api/overrides/not-an-id', { token })).status, 404);
});

test('server faults give a generic 500 with no stack and no internals', async () => {
  const s = await boot();
  const usage = defaultUsage(s.clock);
  const t = await boot({ usage: { ...usage, company: async () => { throw new Error(`boom at /secret/path with ${SECRETS.readKey}`); } } });
  const r = await t.call('GET', '/api/company');
  assert.equal(r.status, 500); assert.deepEqual(r.json, { error: 'internal error' });
  assert.doesNotMatch(r.text, /boom|secret|\bat \w|\.mjs/);
  // a gateway that cannot be reached is a 502 with a short safe message and a retry hint, never a 500
  s.gw.listLimits = async () => { throw new TypeError(`fetch failed: connect ECONNREFUSED http://gw.internal with ${SECRETS.readKey}`); };
  const g = await s.call('GET', '/api/company');
  assert.equal(g.status, 502); assert.deepEqual(g.json, { error: 'gateway unavailable' }); assert.equal(g.headers['retry-after'], '5');
  assert.doesNotMatch(g.text, /ECONN|gw\.internal|secret/i);
  assert.equal((await s.call('GET', '/api/health')).status, 200, 'server survives');
});

test('gateway errors with a status are passed through, health reports an unreachable gateway', async () => {
  const s = await boot(); const token = await s.login();
  const { HttpError } = await import('../lib/http.mjs');
  s.gw.upsert = async () => { throw new HttpError(502, 'gateway 503'); };
  const r = await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } });
  assert.equal(r.status, 502); assert.deepEqual(r.json, { error: 'gateway 503' });
  s.gw.ping = async () => false;
  assert.equal((await s.call('GET', '/api/health')).json.gateway, false);
  s.gw.ping = async () => { throw new Error('down'); };
  assert.equal((await s.call('GET', '/api/health')).json.gateway, false);
});

test('usage backend failing or unconfigured does not break reads', async () => {
  const u = defaultUsage(fakeClock()); u.ok = async () => { throw new Error('ch down'); };
  const s = await boot({ usage: u });
  assert.deepEqual((await s.call('GET', '/api/health')).json.usage, { source: 'demo', ok: false });
  const none = await boot({ usage: fakeUsage({ source: 'none', ok: null }) });
  assert.deepEqual((await none.call('GET', '/api/users')).json.usage, { source: 'none', ok: null });
  assert.equal((await none.call('GET', '/api/users')).json.users.length, 3, 'budgets still listed without usage');
  assert.equal((await none.call('GET', '/api/users/u2')).status, 200);
});

// ---------- no secrets anywhere ----------
test('no response or header ever contains a key, password or the session secret', async () => {
  const s = await boot({ cfg: { inCloud: true } });
  const ada = await s.login(), bob = await s.login('bob@example.com', SECRETS.bobPw);
  const secrets = Object.values(SECRETS);
  const seen = [];
  const hit = async (m, p, o) => { const r = await s.call(m, p, o); seen.push(`${m} ${p} ${r.status}\n${JSON.stringify(r.headers)}\n${r.text}`); return r; };
  await s.call('PUT', '/api/users/u1/budget', { token: ada, body: { period: 'weekly', action: 'set', usd: 5 } });
  await s.call('POST', '/api/overrides', { token: bob, body: { sub: 'u2', period: 'monthly', extraUsd: 5, endsAt: isoAt(s.clock, 5 * H), reason: 'coverage' } });
  for (const p of ['/api/health', '/api/users', '/api/users/u1', '/api/users/u2', '/api/company', '/api/models', '/api/overrides', '/api/audit', '/api/nope', '/', '/api/users/ghost']) { await hit('GET', p); await hit('GET', p, { token: ada }); }
  await hit('POST', '/api/login', { body: { email: 'ada@example.com', password: SECRETS.adaPw } });
  await hit('POST', '/api/login', { body: { email: 'ada@example.com', password: SECRETS.adaPw + 'x' } });
  await hit('POST', '/api/login', { raw: '{' });
  await hit('PUT', '/api/org/budget', { token: ada, body: { period: 'weekly', action: 'set', usd: 'x' } });
  await hit('POST', '/api/internal/tick', { token: ada });
  await hit('POST', '/api/internal/tick', { headers: { authorization: 'Bearer ' + signJwt(s.clock) } });
  assert.ok(seen.length > 25);
  const all = seen.join('\n');
  for (const secret of secrets) { assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 6)}...`); assert.ok(!all.includes(Buffer.from(secret).toString('base64')), 'leaked base64 secret'); }
  assert.ok(!/authorization["']?:\s*"Bearer/i.test(all.replace(/"authorization":"Bearer [^"]*"/g, '')), 'no echoed credentials');
});

// ---------- demo mode ----------
test('demo mode boots with zero external services and shows demo:true everywhere', async () => {
  const cfg = { ...loadConfig({ APP_DEMO: '1', APP_ALLOW_NON_LOOPBACK: '' }), usageSource: 'none' };
  const deps = await buildDeps(cfg);
  const clock = fakeClock('2026-10-13T12:00:00Z'); deps.now = clock.now;
  const app = createApp(cfg, { ...deps, log: silent, lazyTickMs: 0, timerTickMs: 0 });
  const port = await listenFree(app.server); closers.push(() => app.close());
  const get = async (p, o = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, o); return { status: r.status, json: await r.json() }; };
  const health = (await get('/api/health')).json; assert.equal(health.demo, true); assert.equal(health.gateway, true); assert.equal(health.accounts, true);
  for (const p of ['/api/users', '/api/company', '/api/models', '/api/overrides', '/api/audit', '/api/users/demo-ben']) assert.equal((await get(p)).json.demo, true, p);

  const users = (await get('/api/users')).json.users;
  assert.equal(users.length, DEMO_USERS.length);
  const by = Object.fromEntries(users.map((u) => [u.sub, u]));
  assert.equal(by['demo-ben'].budgets.weekly.capCents, 15000); assert.equal(by['demo-ben'].budgets.weekly.spendCents, Math.round(0.91 * 15000));
  assert.equal(by['demo-eli'].budgets.weekly.spendCents, 15000, 'a user at their limit');
  assert.equal(by['demo-gus'].budgets.weekly.capCents, 25000); assert.equal(by['demo-gus'].budgets.weekly.source, 'user');
  assert.equal(by['demo-ivo'].budgets.monthly.unlimited, true); assert.equal(by['demo-ivo'].budgets.monthly.capCents, null);
  assert.ok(new Set(users.map((u) => u.budgets.weekly.spendCents / (u.budgets.weekly.capCents || 1))).size > 6, 'rings vary');
  const audit = (await get('/api/audit')).json.events; assert.ok(audit.length >= 5); assert.ok(audit.every((e) => e.actor === 'admin@example.com'));

  const login = await get('/api/login', { method: 'POST', body: JSON.stringify({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password }), headers: { 'content-type': 'application/json' } });
  assert.equal(login.status, 200);
  const put = await get('/api/users/demo-chen/budget', { method: 'PUT', body: JSON.stringify({ period: 'weekly', action: 'set', usd: 99 }), headers: { 'x-app-token': login.json.token } });
  assert.equal(put.status, 200);
  assert.equal((await get('/api/audit')).json.events[0].actor, 'admin@example.com');
  const bad = await get('/api/login', { method: 'POST', body: JSON.stringify({ email: DEMO_ADMIN.email, password: 'wrong' }) });
  assert.equal(bad.status, 401);
});

// ---------- ticking ----------
test('lazy tick: a request after the throttle window applies due boosts without any scheduler', async () => {
  const s = await boot({ deps: { lazyTickMs: 1000 } });
  const token = await s.login();
  await s.call('POST', '/api/overrides', { token, body: { sub: 'u1', period: 'weekly', extraUsd: 5, startsAt: isoAt(s.clock, 2 * H), endsAt: isoAt(s.clock, 5 * H), reason: 'lazy tick test' } });
  s.clock.advance(3 * H);
  await s.call('GET', '/api/health');
  for (let i = 0; i < 40 && personal(s.gw, 'u1', 'weekly') === null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await effAmount(s.gw, 'u1', 'weekly'), '15500');
  const n = (await s.gw.audit(100)).length;
  await s.call('GET', '/api/users'); await new Promise((r) => setTimeout(r, 30));
  assert.equal((await s.gw.audit(100)).length, n, 'throttled and idempotent');
});

test('the in-process timer ticks when not on Cloud Run, and close() stops it', async () => {
  const clock = fakeClock(); const gw = await seededGateway(clock);
  const usage = fakeUsage();
  const app = createApp(testCfg(), { now: clock.now, gateway: gw, store: memStore(), usage, log: silent, lazyTickMs: 0, timerTickMs: 20 });
  for (let i = 0; i < 50 && usage.ingested < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(usage.ingested >= 2, 'timer fired');
  await app.close();
  const n = usage.ingested; await new Promise((r) => setTimeout(r, 80));
  assert.equal(usage.ingested, n, 'stopped');
  const cloud = createApp(testCfg({}, { inCloud: true }), { now: clock.now, gateway: gw, store: memStore(), usage: fakeUsage(), log: silent, lazyTickMs: 0, timerTickMs: 20 });
  await new Promise((r) => setTimeout(r, 60)); await cloud.close();
});

test('concurrent ticks over HTTP apply once', async () => {
  const s = await boot(); const token = await s.login();
  await s.call('POST', '/api/overrides', { token, body: { sub: 'u3', period: 'weekly', extraUsd: 20, startsAt: isoAt(s.clock, H), endsAt: isoAt(s.clock, 5 * H), reason: 'concurrency' } });
  s.clock.advance(2 * H);
  const res = await Promise.all(Array.from({ length: 6 }, () => s.call('POST', '/api/internal/tick', { token })));
  assert.ok(res.every((r) => r.status === 200));
  assert.equal(await effAmount(s.gw, 'u3', 'weekly'), '17000');
});

test('POST /api/overrides/:id/retry is admin-only, refuses unknown ids and path-shaped ids', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/api/overrides/ov_missing/retry')).status, 401, 'no session');
  const token = await s.login();
  const unknown = await s.call('POST', '/api/overrides/ov_missing/retry', { token });
  assert.ok([404, 409].includes(unknown.status), `unknown id must be refused, got ${unknown.status}`);
  assert.equal((await s.call('POST', '/api/overrides/..%2F..%2Fx/retry', { token })).status, 404, 'path-shaped ids never reach the store');
  // a healthy scheduled boost is not retryable
  const body = { sub: 'u1', period: 'weekly', extraUsd: 10, startsAt: isoAt(s.clock, 2 * H), endsAt: isoAt(s.clock, 30 * H), reason: 'retry check' };
  const created = (await s.call('POST', '/api/overrides', { token, body })).json;
  const notFailed = await s.call('POST', `/api/overrides/${created.id}/retry`, { token });
  assert.equal(notFailed.status, 409, 'only failed boosts can be retried');
});

// ---------- N7: reads degrade when the overrides document is unreadable; writes fail cleanly ----------
test('N7: with a damaged overrides store, reads still answer (200, overrides [], overridesError) and log once a minute; writes that need it return a clean 500', async () => {
  const { createFileStore } = await import('../lib/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'degrade-')); const store = createFileStore(dir); const lines = [];
  const s = await boot({ deps: { store, log: (x) => lines.push(x) } });
  const t = await s.login();
  const made = await s.call('POST', '/api/overrides', { token: t, body: { sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(s.clock, 3 * H), reason: 'before the damage' } });
  assert.equal(made.status, 201);
  for (const bad of ['{"items":[{"id":"ovr_1","su', '{}', '{"items":null}']) {
    fs.writeFileSync(path.join(dir, 'overrides.json'), bad);
    for (const p of ['/api/users', '/api/company', '/api/users/u1', '/api/overrides']) {
      const r = await s.call('GET', p);
      assert.equal(r.status, 200, `${p} with ${bad}: ${r.text.slice(0, 120)}`); assert.equal(r.json.overridesError, true, p);
      if (p === '/api/overrides' || p === '/api/users/u1') assert.deepEqual(r.json.overrides, []);
      if (p === '/api/users') assert.ok(r.json.users.every((u) => u.overrides.length === 0));
      assert.ok(!/overrides\.json|corrupt|\/tmp|\/var\//.test(r.text), 'no file paths in responses: ' + r.text.slice(0, 200));
    }
    const w = await s.call('POST', '/api/overrides', { token: t, body: { sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(s.clock, 3 * H), reason: 'while damaged' } });
    assert.equal(w.status, 500); assert.equal(typeof w.json.error, 'string'); assert.ok(!/overrides\.json|corrupt|\/tmp|\/var\/|at .*\.mjs/.test(w.text), w.text);
    assert.equal(fs.readFileSync(path.join(dir, 'overrides.json'), 'utf8'), bad, 'the damaged file is never replaced');
  }
  const errs = lines.filter((l) => l.evt === 'overrides.store.error');
  assert.ok(errs.length >= 1 && errs.every((l) => l.level === 'error'));
  const before = errs.length; await s.call('GET', '/api/overrides'); await s.call('GET', '/api/company');
  assert.equal(lines.filter((l) => l.evt === 'overrides.store.error').length, before, 'not logged again within a minute');
  s.clock.advance(61e3); await s.call('GET', '/api/overrides?x=1');
  assert.equal(lines.filter((l) => l.evt === 'overrides.store.error').length, before + 1, 'and again after a minute');
  const healthy = JSON.stringify({ items: [] }); fs.writeFileSync(path.join(dir, 'overrides.json'), healthy);
  s.clock.advance(61e3); const ok = await s.call('GET', '/api/overrides?x=2'); assert.equal(ok.status, 200); assert.equal(ok.json.overridesError, undefined);
});
