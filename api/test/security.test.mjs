// Regression tests for the security review of the backend (findings F1, F2, F4, F6, F7, F9 and the correctness items M5, L7, L8, L11).
// Each one fails against the pre-fix behaviour described in its name. Ports: 19300-19319 only.
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, cleanReason } from '../lib/routes.mjs';
import { createAuth } from '../lib/auth.mjs';
import { loadConfig } from '../lib/config.mjs';
import { HttpError } from '../lib/http.mjs';
import { H, SECRETS, fakeClock, fakeUsage, isoAt, memStore, personal, seededGateway, silent, testCfg, testEnv } from './api-helpers.mjs';
import { fakeGoogle, signJwt } from './security-fixtures.mjs';

let nextPort = 19300;
async function listenFree(server) {
  for (let tries = 0; tries < 20; tries++) {
    const port = nextPort; nextPort = nextPort >= 19319 ? 19300 : nextPort + 1;
    try { await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); ok(); }); }); return port; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free test port in 19300-19319');
}
const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
after(async () => { while (closers.length) await closers.pop()(); });

async function boot({ env = {}, cfg: patch = {}, deps = {}, gateway, usage, logs = [] } = {}) {
  const clock = fakeClock();
  const gw = gateway || await seededGateway(clock);
  const cfg = testCfg(env, patch);
  const u = usage || fakeUsage({ roster: new Map([['u1', 'u1@example.com']]), users: [{ sub: 'u1', email: 'u1@example.com', requests: 5, ok: 5, lastSeen: null, models: [] }] });
  const app = createApp(cfg, { now: clock.now, gateway: gw, store: memStore(), usage: u, log: (o) => logs.push(o), lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0, ...deps });
  const port = await listenFree(app.server);
  closers.push(() => app.close());
  const call = (method, p, { body, raw, token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(token ? { 'x-app-token': token } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, setHost: !('host' in h) }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text: t, json }); });
    });
    req.on('error', reject); req.end(payload);
  });
  const login = async (email = 'ada@example.com', password = SECRETS.adaPw) => (await call('POST', '/api/login', { body: { email, password } })).json?.token;
  return { app, clock, gw, port, call, login, cfg, logs, usage: u };
}
// counts calls to the given methods of an object
const counting = (obj, names) => { const n = {}; for (const k of names) { const f = obj[k].bind(obj); n[k] = 0; obj[k] = (...a) => { n[k]++; return f(...a); }; } return n; };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------- config ----------
test('config: minimum lengths, no session-secret fallback on Cloud Run, SCHEDULER_AUDIENCE required, demo guard, dev CORS, APP_MAX_OVERRIDE_DAYS', () => {
  const ok = testEnv();
  assert.ok(loadConfig(ok));
  const admins = (password) => JSON.stringify([{ email: 'a@example.com', password, writeKey: 'k' }]);
  assert.throws(() => loadConfig({ ...ok, APP_ADMINS: admins('a') }), /at least 12/);
  assert.throws(() => loadConfig({ ...ok, APP_ADMINS: admins('12345678901') }), /at least 12/);
  assert.ok(loadConfig({ ...ok, APP_ADMINS: admins('123456789012') }));
  const local = { GATEWAY_ADMIN_READ_KEY: 'r', GATEWAY_ADMIN_WRITE_KEY: 'w', APP_SESSION_SECRET: 'abcdefghij0123456789ABCDEFGHIJ-_' };
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'short' }), /APP_ADMIN_PASSWORD/);
  assert.ok(loadConfig({ ...local, APP_ADMIN_PASSWORD: 'long-enough-pw' }));
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'long-enough-pw', APP_SESSION_SECRET: 'a' }), /at least 32/);
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'long-enough-pw', APP_SESSION_SECRET: 'abcdefghij0123456789ABCDEFGHI-' }), /at least 32/);
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'long-enough-pw', APP_SESSION_SECRET: 'ab'.repeat(20) }), /repetitive/);
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'aaaaaaaaaaaaaaaa' }), /repetitive/);
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: '1212121212121212' }), /repetitive/);
  assert.throws(() => loadConfig({ ...ok, APP_ADMINS: admins('abcabcabcabcabc') }), /repetitive/);
  assert.ok(loadConfig({ APP_DEMO: '1', APP_SESSION_SECRET: 'a' }).demo, 'demo is exempt');
  const two = (a, b) => JSON.stringify([{ email: a, password: 'a-fine-password-1', writeKey: 'k' }, { email: b, password: 'a-fine-password-2', writeKey: 'k2' }]);
  assert.throws(() => loadConfig({ ...ok, APP_ADMINS: two('Ada@Example.com', 'ada@example.com') }), /twice/);
  assert.ok(loadConfig({ ...ok, APP_ADMINS: two('ada@example.com', 'bob@example.com') }));
  // session secret: derived locally from the gateway JWT secret (domain separated), never on Cloud Run
  const noSecret = { ...local, APP_ADMIN_PASSWORD: 'long-enough-pw', APP_SESSION_SECRET: '', GATEWAY_JWT_SECRET: 'jwt-secret-of-the-gateway-0123456789' };
  const derived = loadConfig(noSecret).sessionSecret;
  assert.equal(derived.length, 64); assert.notEqual(derived, noSecret.GATEWAY_JWT_SECRET);
  assert.equal(loadConfig(noSecret).sessionSecret, derived, 'stable across restarts');
  assert.throws(() => loadConfig({ ...noSecret, K_SERVICE: 'budget' }), /required on Cloud Run/);
  assert.throws(() => loadConfig({ ...local, APP_ADMIN_PASSWORD: 'long-enough-pw', APP_SESSION_SECRET: '' }), /missing APP_SESSION_SECRET/);
  // scheduler
  assert.throws(() => loadConfig({ ...ok, SCHEDULER_AUDIENCE: '' }), /SCHEDULER_AUDIENCE/);
  assert.equal(loadConfig(ok).schedulerAudience, ok.SCHEDULER_AUDIENCE);
  // demo mode is not allowed on Cloud Run by accident, and is exempt from the length rules
  assert.throws(() => loadConfig({ APP_DEMO: '1', K_SERVICE: 'budget' }), /demo mode on Cloud Run/);
  assert.ok(loadConfig({ APP_DEMO: '1', K_SERVICE: 'budget', APP_DEMO_ALLOW_CLOUD: '1' }).demo);
  assert.ok(loadConfig({ APP_DEMO: '1' }).demo);
  // dev CORS origins: only off Cloud Run and only with APP_DEV=1
  assert.equal(loadConfig(ok).devOrigins.size, 0);
  assert.equal(loadConfig({ ...ok, APP_DEV: '1' }).devOrigins.size, 2);
  assert.equal(loadConfig({ ...ok, APP_DEV: '1', K_SERVICE: 'budget' }).devOrigins.size, 0);
  // cache knobs
  assert.equal(loadConfig(ok).readCacheMs, 8000); assert.equal(loadConfig({ ...ok, APP_HEALTH_CACHE_MS: '0' }).healthCacheMs, 0);
  for (const bad of ['-1', 'x', '60001', '1.5']) assert.throws(() => loadConfig({ ...ok, APP_READ_CACHE_MS: bad }), /APP_READ_CACHE_MS/, bad);
  // APP_MAX_OVERRIDE_DAYS
  assert.equal(loadConfig(ok).maxOverrideDays, 90);
  assert.equal(loadConfig({ ...ok, APP_MAX_OVERRIDE_DAYS: '30' }).maxOverrideDays, 30);
  assert.equal(loadConfig({ ...ok, APP_MAX_OVERRIDE_DAYS: '1.5' }).maxOverrideDays, 1.5);
  for (const bad of ['0', '-5', 'abc', '1e3', '0x10', '366', '0.5', 'NaN', ' ;']) assert.throws(() => loadConfig({ ...ok, APP_MAX_OVERRIDE_DAYS: bad }), /APP_MAX_OVERRIDE_DAYS/, bad);
});

test('dev CORS is off on Cloud Run and without APP_DEV=1 (regression: localhost:8081 was always allowed)', async () => {
  const hdr = { origin: 'http://localhost:8081' };
  const plain = await boot();
  const r = await plain.call('GET', '/api/models', { headers: hdr });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.status, 403, 'a foreign origin is refused outright');
  const dev = await boot({ env: { APP_DEV: '1' } });
  assert.equal((await dev.call('GET', '/api/models', { headers: hdr })).headers['access-control-allow-origin'], 'http://localhost:8081');
  const cloud = await boot({ env: { APP_DEV: '1' }, cfg: { inCloud: true, devOrigins: new Set() } });
  assert.equal((await cloud.call('GET', '/api/models', { headers: hdr })).headers['access-control-allow-origin'], undefined);
});

// ---------- F1 ----------
test('F1: /api/internal/tick refuses unsigned, wrong-audience and forged tokens, and accepts a real one (regression: claims-only tokens were trusted)', async () => {
  const google = fakeGoogle();
  const s = await boot({ cfg: { inCloud: true }, deps: { fetch: google.fetch } });
  const post = (t) => s.call('POST', '/api/internal/tick', { headers: { authorization: 'Bearer ' + t } });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = b64({ alg: 'RS256', typ: 'JWT', kid: 'good-kid' }) + '.' + b64({ iss: 'https://accounts.google.com', email: s.cfg.schedulerSa, email_verified: true, aud: 'attacker', exp: Math.floor(s.clock.t / 1000) + 3600 }) + '.AAAA';
  assert.equal((await post(forged)).status, 401);
  assert.equal((await post(signJwt(s.clock, { aud: 'attacker' }))).status, 401);
  assert.equal((await post(signJwt(s.clock, {}, { alg: 'none' }))).status, 401);
  assert.equal((await post(signJwt(s.clock))).status, 200);
});

// ---------- F2 ----------
const loginCfg = (patch = {}) => testCfg({}, patch);
const fails = (auth, body, ip) => { try { auth.login(body, { ip }); return 200; } catch (e) { return e.status; } };

test('F2: unknown emails never lock a real account, and a lock on one address never reaches another', () => {
  const clock = fakeClock(); const auth = createAuth(loginCfg(), { now: clock.now, log: silent });
  for (let i = 0; i < 9; i++) assert.equal(fails(auth, { email: `ghost${i}@x.com`, password: 'x' }, '203.0.113.9'), 401);
  assert.equal(fails(auth, { email: 'ada@example.com', password: SECRETS.adaPw }, '198.51.100.1'), 200, 'real admin from another address is fine');
  // a made-up email and a real one are throttled by the same rules, so a 429 reveals nothing about who exists
  for (let i = 0; i < 5; i++) { assert.equal(fails(auth, { email: 'ghost@x.com', password: 'x' }, '203.0.113.50'), 401); assert.equal(fails(auth, { email: 'ada@example.com', password: 'x' }, '203.0.113.51'), 401); }
  assert.equal(fails(auth, { email: 'ghost@x.com', password: 'x' }, '203.0.113.50'), 429);
  assert.equal(fails(auth, { email: 'ada@example.com', password: 'x' }, '203.0.113.51'), 429);
  assert.equal(fails(auth, { email: 'ghost@x.com', password: 'x' }, '203.0.113.52'), 401, 'a different address is not locked');
});

test('N2: an attacker address is locked while the real admin from a clean address can always sign in (regression: 5 wrong passwords locked the account for everyone)', () => {
  const clock = fakeClock(); const auth = createAuth(loginCfg(), { now: clock.now, log: silent });
  const attacker = '203.0.113.66', admin = '198.51.100.7';
  for (let i = 0; i < 5; i++) assert.equal(fails(auth, { email: 'ada@example.com', password: 'guess' + i }, attacker), 401);
  assert.equal(fails(auth, { email: 'ada@example.com', password: 'guess5' }, attacker), 429, 'guessing from that address stays throttled');
  assert.equal(fails(auth, { email: 'ada@example.com', password: SECRETS.adaPw }, attacker), 429, 'even a correct guess from the locked address is refused');
  for (let i = 0; i < 3; i++) assert.equal(fails(auth, { email: 'ada@example.com', password: SECRETS.adaPw }, admin), 200, 'the admin is never locked out');
  // switching accounts does not help the attacker: the address bucket locks after 10 failures overall
  for (let i = 0; i < 20; i++) assert.ok([401, 429].includes(fails(auth, { email: `u${i}@x.com`, password: 'x' }, attacker)));
  assert.equal(fails(auth, { email: 'bob@example.com', password: SECRETS.bobPw }, attacker), 429);
  assert.equal(fails(auth, { email: 'bob@example.com', password: SECRETS.bobPw }, admin), 200);
});

test('N2: 50 failures an hour from many addresses raises admin.login.suspicious and slows the account, but a correct password from a clean address still gets in', () => {
  const logs = []; const clock = fakeClock(); const auth = createAuth(loginCfg(), { now: clock.now, log: (o) => logs.push(o) });
  const attempt = (pw, ip) => { try { return auth.login({ email: 'ada@example.com', password: pw }, { ip }); } catch (e) { return e; } };
  for (let i = 0; i < 49; i++) assert.equal(attempt('guess', `192.0.2.${i}`).delayMs, 0);
  assert.equal(logs.filter((l) => l.evt === 'admin.login.suspicious').length, 0);
  assert.equal(attempt('guess', '192.0.2.200').status, 401);                       // the 50th
  const alerts = logs.filter((l) => l.evt === 'admin.login.suspicious');
  assert.equal(alerts.length, 1); assert.ok(!JSON.stringify(alerts).includes('ada@'), 'no email in the alert');
  const slowFail = attempt('guess', '192.0.2.201'); assert.equal(slowFail.status, 401); assert.equal(slowFail.delayMs, 1500);
  assert.equal(logs.filter((l) => l.evt === 'admin.login.suspicious').length, 1, 'alerted once per window');
  const ok = attempt(SECRETS.adaPw, '198.51.100.9');
  assert.ok(ok.token, 'a correct password from a clean address is never blocked'); assert.equal(ok.delayMs, 1500, 'but it is slowed');
  clock.advance(61 * 60e3);
  assert.equal(attempt(SECRETS.adaPw, '198.51.100.10').delayMs, 0, 'back to normal after the window');
  assert.equal(auth.login({ email: 'bob@example.com', password: SECRETS.bobPw }, { ip: '198.51.100.11' }).delayMs, 0, 'other accounts are not slowed');
});

test('N2: over HTTP the slow-down is a real delay and the response body is unchanged', async () => {
  const delays = []; const s = await boot({ deps: { sleep: async (ms) => { delays.push(ms); } } });
  const r = await s.call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } });
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['email', 'name', 'token']); assert.deepEqual(delays, []);
  const slowAuth = { ...s.app.auth, login: () => ({ token: 't', email: 'e', name: 'n', delayMs: 1500 }) };
  const t = await boot({ deps: { auth: slowAuth, sleep: async (ms) => { delays.push(ms); } } });
  const slow = await t.call('POST', '/api/login', { body: { email: 'x', password: 'y' } });
  assert.deepEqual(slow.json, { token: 't', email: 'e', name: 'n' }); assert.deepEqual(delays, [1500]);
});

test('F2: lockout schedule doubles up to a cap; success resets the account counter', () => {
  const clock = fakeClock(); const auth = createAuth(loginCfg(), { now: clock.now, log: silent });
  const bad = (ip) => { try { auth.login({ email: 'bob@example.com', password: 'bad' }, { ip }); } catch (e) { return e; } };
  const good = (ip) => auth.login({ email: 'bob@example.com', password: SECRETS.bobPw }, { ip });
  for (let i = 0; i < 4; i++) assert.equal(bad('x').status, 401);
  good('x');                                                      // clears bob's counter for this address
  for (let i = 0; i < 4; i++) assert.equal(bad('x').status, 401); // 4 fresh failures: still not locked
  assert.equal(bad('x').status, 401);                             // 5th failure sets the first lock
  const waits = [];
  for (let round = 0; round < 6; round++) {
    const e = bad('x');                                           // locked: 429 with the remaining time
    assert.equal(e.status, 429); const w = Number(e.headers['retry-after']); waits.push(w);
    clock.advance(w * 1000 + 1);
    assert.equal(bad('x').status, 401, 'one more failure after each lock expires');
  }
  assert.ok(waits[1] > waits[0] && waits[2] > waits[1], 'grows: ' + waits);
  assert.ok(Math.max(...waits) <= 15 * 60, 'capped at 15 minutes');
  assert.throws(() => good('x'), (e) => e.status === 429, 'right password refused from the locked address');
  clock.advance(31 * 60e3);
  assert.ok(good('x').token);
  assert.equal(bad('x').status, 401, 'counter started again from zero');
});

test('F2: one address spraying many accounts is throttled per IP, and tracking tables are bounded and expire', () => {
  const clock = fakeClock(); const auth = createAuth(loginCfg(), { now: clock.now, log: silent });
  for (let i = 0; i < 10; i++) assert.equal(fails(auth, { email: `u${i}@x.com`, password: 'x' }, '203.0.113.5'), 401);
  assert.equal(fails(auth, { email: 'ada@example.com', password: SECRETS.adaPw }, '203.0.113.5'), 429, 'the sprayer is locked out');
  assert.equal(fails(auth, { email: 'ada@example.com', password: SECRETS.adaPw }, '203.0.113.6'), 200);
  for (let i = 0; i < 12000; i++) fails(auth, { email: `bulk${i}@x.com`, password: 'x' }, `10.${i >> 8 & 255}.${i & 255}.${i % 7}`);
  const sizes = auth.throttleSizes();
  assert.ok(sizes.ip <= 5000 && sizes.ghost <= 5000 && sizes.account <= 5000, JSON.stringify(sizes));
  clock.advance(70 * 60e3);
  fails(auth, { email: 'late@x.com', password: 'x' }, '1.1.1.1');       // inserting prunes the idle entries
  assert.ok(auth.throttleSizes().ip < 5000);
});

test('F2: the client address is the last X-Forwarded-For hop on Cloud Run and the socket address otherwise', async () => {
  const bad = (s, xff, n) => s.call('POST', '/api/login', { body: { email: `ghost${n}@example.com`, password: 'x' }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  const cloud = await boot({ cfg: { inCloud: true } });
  // an attacker prepending addresses cannot dodge the limit: only the hop Google added counts
  for (let i = 0; i < 10; i++) assert.equal((await bad(cloud, `10.0.0.${i}, 198.51.100.7`, i)).status, 401);
  assert.equal((await bad(cloud, '10.9.9.9, 198.51.100.7', 99)).status, 429);
  assert.equal((await bad(cloud, '10.9.9.9, 198.51.100.8', 98)).status, 401, 'a different last hop is a different client');
  const local = await boot();
  for (let i = 0; i < 10; i++) assert.equal((await bad(local, `10.0.0.${i}`, i)).status, 401);
  assert.equal((await bad(local, '10.9.9.9', 99)).status, 429, 'off Cloud Run the header is ignored: same socket address');
});

test('F2: login events: admin.login.failed {reason} without email or password, admin.login on success', async () => {
  const logs = [];
  const s = await boot({ logs });
  await s.call('POST', '/api/login', { body: { email: 'victim@example.com', password: 'hunter2-hunter2' } });
  await s.call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'wrong-wrong-wrong' } });
  await s.login();
  const failed = logs.filter((l) => l.evt === 'admin.login.failed');
  assert.deepEqual(failed, [{ evt: 'admin.login.failed', reason: 'bad_credentials' }, { evt: 'admin.login.failed', reason: 'bad_credentials' }]);
  assert.equal(logs.filter((l) => l.evt === 'admin.login').length, 1);
  const all = JSON.stringify(logs);
  for (const x of ['victim@example.com', 'hunter2', 'wrong-wrong', SECRETS.adaPw]) assert.ok(!all.includes(x), x);
});

// ---------- F6 ----------
test('F6: POST /api/logout revokes every session of that account, tokens carry iat, a restart revokes everything', async () => {
  const logs = []; const s = await boot({ logs });
  const t1 = await s.login(), t2 = await s.login(), bob = await s.login('bob@example.com', SECRETS.bobPw);
  const payload = JSON.parse(Buffer.from(t1.split('.')[0], 'base64url'));
  assert.equal(payload.iat, s.clock.t); assert.ok(payload.exp > payload.iat);
  const write = (token) => s.call('PUT', '/api/org/budget', { token, body: { period: 'weekly', action: 'set', usd: 100 } });
  assert.equal((await write(t1)).status, 200);
  assert.equal((await s.call('POST', '/api/logout', {})).status, 401, 'needs a session');
  assert.equal((await s.call('POST', '/api/logout', { token: t1 })).status, 200);
  assert.equal((await write(t1)).status, 401); assert.equal((await write(t2)).status, 401, 'the account\'s other session is gone too');
  assert.equal((await write(bob)).status, 200, 'other accounts are untouched');
  assert.equal((await s.call('GET', '/api/health', { token: t1 })).json.admin, null);
  const t3 = await s.login(); assert.equal((await write(t3)).status, 200, 'signing in again works');
  assert.ok(logs.some((l) => l.evt === 'admin.logout' && l.email === 'ada@example.com'));
  // a new process (same secret) does not honour tokens minted before it started
  s.clock.advance(1);
  const restarted = createAuth(testCfg(), { now: s.clock.now, log: silent });
  assert.equal(restarted.optionalAdmin({ headers: { 'x-app-token': t3 } }), null);
  // nor does a different APP_SESSION_SECRET
  const rotated = createAuth(testCfg({ APP_SESSION_SECRET: 'rotated-secret-0123456789-abcdefghijklmn' }), { now: s.clock.now, log: silent });
  assert.equal(rotated.optionalAdmin({ headers: { 'x-app-token': bob } }), null);
});

// ---------- F7 ----------
test('F7: open reads are cached, identical in-flight requests are coalesced, and a write clears the cache at once', async () => {
  const s = await boot({ deps: { readCacheMs: 8000, healthCacheMs: 10000 } });
  const n = counting(s.gw, ['listLimits', 'effectiveAll', 'effective', 'audit']);
  const first = await s.call('GET', '/api/users?range=7d'); assert.equal(first.status, 200);
  const base = n.listLimits;
  for (let i = 0; i < 20; i++) await s.call('GET', '/api/users?range=7d&junk=' + i);       // unknown parameters do not bust the cache
  assert.equal(n.listLimits, base, 'served from cache');
  assert.deepEqual((await s.call('GET', '/api/users?range=7d')).json, first.json);
  s.clock.advance(9000);
  await s.call('GET', '/api/users?range=7d'); assert.ok(n.listLimits > base, 'refreshed after the TTL');

  // coalescing: a burst of identical requests costs one computation
  const s2 = await boot({ deps: { readCacheMs: 0 } });
  const slowLimits = s2.gw.listLimits.bind(s2.gw); s2.gw.listLimits = async () => { await tick(60); return slowLimits(); };
  const n2 = counting(s2.gw, ['listLimits']);
  await Promise.all(Array.from({ length: 30 }, () => s2.call('GET', '/api/company?range=30d')));
  assert.ok(n2.listLimits <= 2, 'coalesced: ' + n2.listLimits);

  // invalidation: the UI never shows stale data after a save
  const token = await s.login();
  const before = (await s.call('GET', '/api/users')).json.users.find((u) => u.sub === 'u1').budgets.weekly.capCents;
  assert.equal(before, 15000);
  assert.equal((await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 42 } })).status, 200);
  assert.equal((await s.call('GET', '/api/users')).json.users.find((u) => u.sub === 'u1').budgets.weekly.capCents, 4200);
  assert.equal((await s.call('GET', '/api/users/u1')).json.user.budgets.weekly.capCents, 4200);
  assert.equal((await s.call('GET', '/api/audit')).json.events[0].toCents, 4200);
  const created = await s.call('POST', '/api/overrides', { token, body: { sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(s.clock, 5 * H), reason: 'cache check' } });
  assert.equal(created.status, 201);
  assert.equal((await s.call('GET', '/api/overrides')).json.overrides.length, 1);
  { const c = (await s.call('GET', '/api/company')).json.overrides; assert.equal(c.active + c.scheduled, 1); }
  assert.equal((await s.call('DELETE', '/api/overrides/' + created.json.id, { token })).status, 200);
  assert.equal((await s.call('GET', '/api/overrides')).json.overrides[0].status, 'cancelled');
  { const c = (await s.call('GET', '/api/company')).json.overrides; assert.equal(c.active + c.scheduled, 0); }
});

test('F7: a write while a read is in flight never leaves the old answer in the cache', async () => {
  const s = await boot({ deps: { readCacheMs: 8000 } });
  const token = await s.login();
  const real = s.gw.listLimits.bind(s.gw); let gate;
  const held = new Promise((r) => { gate = r; });
  s.gw.listLimits = async () => { const v = await real(); await held; return v; };
  const slowRead = s.call('GET', '/api/company');
  await tick(30);
  s.gw.listLimits = real;
  const put = await s.call('PUT', '/api/org/budget', { token, body: { period: 'weekly', action: 'set', usd: 1 } });
  assert.equal(put.status, 200);
  gate(); await slowRead;
  assert.equal((await s.call('GET', '/api/company')).json.org.weekly.amountCents, 100, 'the stale in-flight result was not cached');
});

test('F7: /api/health is cheap (probes cached ~10s) and exposes only the documented fields', async () => {
  const s = await boot({ deps: { healthCacheMs: 10000 } });
  const n = counting(s.gw, ['ping']); let okCalls = 0; const ok = s.usage.ok; s.usage.ok = async () => { okCalls++; return ok(); };
  const first = await s.call('GET', '/api/health');
  for (let i = 0; i < 50; i++) await s.call('GET', '/api/health');
  assert.equal(n.ping, 1); assert.equal(okCalls, 1);
  assert.deepEqual(Object.keys(first.json).sort(), ['accounts', 'admin', 'demo', 'gateway', 'maxOverrideDays', 'usage', 'viewAccess']);
  assert.deepEqual(Object.keys(first.json.usage).sort(), ['ok', 'source']);
  s.gw.ping = async () => false; s.clock.advance(11000);
  assert.equal((await s.call('GET', '/api/health')).json.gateway, false, 'refreshed after the TTL');
  await s.call('GET', '/api/users'); await s.call('GET', '/api/company');
  assert.equal(okCalls, 2, 'reads reuse the usage probe too');
});

test('F7/N3: anonymous work is capped at 3 of 4 workers, an anonymous flood is answered 503, and signed-in admins still get through', async () => {
  let running = 0, peak = 0; let release; const gate = new Promise((r) => { release = r; });
  const s = await boot({ deps: { readCacheMs: 0 } });
  const audit = s.gw.audit.bind(s.gw);
  s.gw.audit = async (n) => { running++; peak = Math.max(peak, running); await gate; running--; return audit(n); };
  const token = await s.login();
  const flood = Array.from({ length: 100 }, (_, i) => s.call('GET', `/api/audit?limit=${i + 1}`));      // distinct keys: nothing coalesces
  await tick(150);
  assert.equal(peak, 3, 'anonymous callers use three workers, one stays free');
  assert.equal((await s.call('GET', '/api/models', { token })).status, 200, 'the admin dashboard is not starved');
  assert.equal((await s.call('GET', '/api/users', { token })).status, 200);
  release();
  const res = await Promise.all(flood);
  const codes = res.map((r) => r.status);
  assert.ok(codes.includes(503), 'the flood beyond 3 running + 48 queued is refused');
  assert.ok(codes.every((c) => c === 200 || c === 503), JSON.stringify([...new Set(codes)]));
  assert.ok(codes.filter((c) => c === 200).length >= 51 - 3);
  assert.ok(res.filter((r) => r.status === 503).every((r) => r.headers['retry-after']));
});

test('N3: a flood of made-up /api/users/<id> is cheap (one cached lookup), never 500/503, and does not hurt admin reads', async () => {
  const s = await boot({ deps: { readCacheMs: 8000 } });
  const token = await s.login();
  const n = counting(s.gw, ['effectiveAll', 'effective', 'listLimits']);
  const flood = Array.from({ length: 300 }, (_, i) => s.call('GET', `/api/users/nobody-${i}-${Math.random().toString(36).slice(2)}`));
  const [dash, ...res] = await Promise.all([s.call('GET', '/api/users', { token }), ...flood]);
  assert.equal(dash.status, 200);
  assert.ok(res.every((r) => r.status === 404 && r.json.error === 'unknown user'), JSON.stringify([...new Set(res.map((r) => r.status))]));
  assert.ok(n.effectiveAll <= 4 && n.effective <= 4, `gateway calls for 300 unknown ids: ${JSON.stringify(n)}`);
  assert.equal((await s.call('GET', '/api/users/u1')).status, 200, 'known users still resolve');
  assert.equal((await s.call('GET', '/api/users/u2', { token })).status, 200);
  assert.equal((await s.call('GET', '/api/users/bad%20id')).status, 400, 'bad ids fail before any lookup');
});

// ---------- M5 ----------
test('M5: a slow usage ingest never delays an override revert, and an ingest failure does not fail the override result', async () => {
  const clock = fakeClock(); const gw = await seededGateway(clock); let release;
  const slow = new Promise((r) => { release = r; });
  const usage = { ...fakeUsage(), async ingest() { await slow; return { ingested: 1 }; } };
  const s = await boot({ gateway: gw, usage, deps: { now: clock.now } });
  s.clock.t = clock.t;
  const admin = { email: 'ada@example.com', name: 'Ada', writeKey: SECRETS.adaKey };
  await s.app.overrides.create({ sub: 'u1', period: 'weekly', extraUsd: 50, startsAt: isoAt(clock, H), endsAt: isoAt(clock, 3 * H), reason: 'slow ingest test' }, admin);
  clock.advance(1.5 * H); const t1 = s.app.tick(); await tick(60);
  assert.equal(personal(gw, 'u1', 'weekly')?.amount, '20000', 'boost applied while ingest hangs');
  clock.advance(2 * H);
  const t2 = s.app.tick(); await tick(60);
  assert.equal(personal(gw, 'u1', 'weekly'), null, 'reverted although the first ingest is still stuck');
  release(); await Promise.all([t1, t2]);

  const failing = await boot({ usage: { ...fakeUsage(), async ingest() { throw new Error('secret upstream detail'); } }, logs: [] });
  const token = await failing.login();
  const r = await failing.call('POST', '/api/internal/tick', { token });
  assert.equal(r.status, 200); assert.ok(r.json.overrides); assert.deepEqual(r.json.usage, { ingested: 0, error: 'ingest failed' });
  assert.doesNotMatch(r.text, /secret upstream/);
  const broken = await boot({}); broken.app.overrides.tick = async () => { throw new Error('revert failed'); };
  assert.equal((await broken.call('POST', '/api/internal/tick', { token: await broken.login() })).status, 500, 'an override failure still fails the tick');
});

// ---------- F9 / L5 / L9 ----------
test('F9: budget and boost amounts must be plain decimals worth whole cents', async () => {
  const s = await boot(); const token = await s.login();
  const put = (usd) => s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd } });
  const post = (extraUsd) => s.call('POST', '/api/overrides', { token, body: { sub: 'u1', period: 'monthly', extraUsd, endsAt: isoAt(s.clock, 5 * H), reason: 'amount check' } });
  for (const bad of ['0x10', '0X1F', '1e3', '1E2', ' ', '', ' 5', '5 ', '1_000', '0.004', 0.004, 1.005, '1.005', '12.345', [5], null, true, '-1', '٣']) {
    const r = await put(bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.json.error, /amount/);
    if (bad !== '' && bad !== ' ') assert.equal((await post(bad)).status, 400, 'override ' + JSON.stringify(bad));
  }
  assert.match((await put(1.005)).json.error, /cent/);
  for (const [good, cents] of [['12', '1200'], [12.5, '1250'], ['12.50', '1250'], ['12.5000', '1250'], [0.1, '10'], [0.29, '29'], [19.99, '1999']]) {
    const r = await put(good); assert.equal(r.status, 200, String(good)); assert.equal(r.json.limit.amount, cents, String(good));
  }
  const ok = await post('12.34'); assert.equal(ok.status, 201); assert.equal(ok.json.extraCents, 1234);
});

test('L9: override reasons lose control and bidi-override characters before they are stored', async () => {
  assert.equal(cleanReason('on‮call‬  rota\u0000\u0007 swap​'), 'oncall rota swap');
  assert.equal(cleanReason('line one\nline two\ttabbed'), 'line one line two tabbed');
  assert.equal(cleanReason('⁦hidden⁩ text‏'), 'hidden text');
  const s = await boot(); const token = await s.login();
  const r = await s.call('POST', '/api/overrides', { token, body: { sub: 'u1', period: 'weekly', extraUsd: 5, endsAt: isoAt(s.clock, 5 * H), reason: 'incident ‮severe‬\u0000 #42\r\nsecond line' } });
  assert.equal(r.status, 201); assert.equal(r.json.reason, 'incident severe #42 second line');
  const short = await s.call('POST', '/api/overrides', { token, body: { sub: 'u1', period: 'monthly', extraUsd: 5, endsAt: isoAt(s.clock, 5 * H), reason: '‮‮ ab \u0000' } });
  assert.equal(short.status, 400, 'too short once cleaned');
});

test('F9: gateway error text is generic for anonymous callers, short and plain for admins; unreachable means 502 with Retry-After', async () => {
  const s = await boot(); const token = await s.login();
  s.gw.listLimits = async () => { throw new HttpError(500, 'upstream said: {"error":"db password=hunter2 at /srv/gw/db.js:12"}'); };
  const anon = await s.call('GET', '/api/company');
  assert.equal(anon.status, 502); assert.deepEqual(anon.json, { error: 'gateway unavailable' }); assert.equal(anon.headers['retry-after'], '5');
  s.gw.listLimits = async () => { throw new HttpError(400, 'bad amount for scope'); };
  const anon4 = await s.call('GET', '/api/users'); assert.equal(anon4.status, 502); assert.equal(anon4.json.error, 'gateway unavailable');
  s.gw.upsert = async () => { throw new HttpError(409, 'limit already exists'); };
  s.gw.listLimits = async () => [];
  const adm = await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } });
  assert.equal(adm.status, 409); assert.equal(adm.json.error, 'limit already exists');
  s.gw.upsert = async () => { throw new HttpError(400, 'bad {"stack":"at /srv/x.js:1"} password=hunter2'); };
  const unsafe = await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } });
  assert.equal(unsafe.status, 400); assert.equal(unsafe.json.error, 'gateway error'); assert.doesNotMatch(unsafe.text, /hunter2|srv/);
  s.gw.upsert = async () => { throw new TypeError('fetch failed: ECONNREFUSED 10.1.2.3:443'); };
  const down = await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } });
  assert.equal(down.status, 502); assert.deepEqual(down.json, { error: 'gateway unavailable' }); assert.equal(down.headers['retry-after'], '5');
});

test('budget PUT for a user nobody has seen is a 404, like override creation; a user known by limit, roster or gateway actor is fine', async () => {
  const s = await boot(); const token = await s.login();
  const put = (sub) => s.call('PUT', `/api/users/${sub}/budget`, { token, body: { period: 'weekly', action: 'set', usd: 5 } });
  const before = (await s.gw.audit(100)).length;
  assert.equal((await put('never-seen')).status, 404);
  assert.equal((await s.call('PUT', '/api/users/never-seen/budget', { token, body: { period: 'weekly', action: 'inherit' } })).status, 404);
  assert.equal((await s.gw.audit(100)).length, before, 'nothing written');
  assert.equal((await put('u2')).status, 200, 'known to the gateway (actor with an email)');
  assert.equal((await put('u1')).status, 200, 'in the usage roster');
  // the real gateway answers for unseen ids with a null actor: that is not enough
  const eff = s.gw.effective.bind(s.gw);
  s.gw.effective = async (subs) => (await eff(subs)).map((r) => ({ ...r, actor: null }));
  assert.equal((await put('u3')).status, 404, 'null actor, no limit, not in roster');
  assert.equal((await put('u2')).status, 200, 'now has a personal limit');
});

// ---------- L7 / L8 ----------
test('L7: Company userOverrides counts people with a personal cap, not limit rows', async () => {
  const s = await boot(); const token = await s.login();
  await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 10 } });
  await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'monthly', action: 'set', usd: 40 } });
  await s.call('PUT', '/api/users/u2/budget', { token, body: { period: 'monthly', action: 'unlimited' } });
  assert.equal((await s.call('GET', '/api/company')).json.userOverrides, 2, 'three limit rows, two people');
});

test('L8: the per-user audit asks the gateway for its maximum (500) and says when that may have cut history off', async () => {
  const s = await boot(); const token = await s.login();
  const asked = []; const audit = s.gw.audit.bind(s.gw); s.gw.audit = async (n) => { asked.push(n); return audit(n); };
  await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 10 } });
  const d = await s.call('GET', '/api/users/u1');
  assert.ok(asked.includes(500)); assert.equal(d.json.auditTruncated, false); assert.equal(d.json.audit.length, 1);
  // 300 newer events about other people used to push this user's change out of a 200-event window
  for (let i = 0; i < 300; i++) await s.gw.upsert({ type: 'user', user_id: 'u3' }, 'weekly', 100 + i, { key: 'k', actor: 'x' });
  assert.equal((await s.call('GET', '/api/users/u1')).json.audit.length, 1, 'still visible');
  for (let i = 0; i < 250; i++) await s.gw.upsert({ type: 'user', user_id: 'u3' }, 'monthly', 100 + i, { key: 'k', actor: 'x' });
  const cut = (await s.call('GET', '/api/users/u1')).json;
  assert.equal(cut.auditTruncated, true);
});

// ---------- Host header ----------
test('Host header is parsed strictly: userinfo, trailing dot, non-numeric ports and junk are refused; the run.app suffix still works', async () => {
  const s = await boot({ cfg: { allowedHostSuffixes: ['.run.app'] } });
  const status = async (host) => (await s.call('GET', '/api/health', { headers: { host } })).status;
  for (const ok of ['localhost', 'localhost:8792', 'LOCALHOST:1', '127.0.0.1:19300', '[::1]:8792', '[::1]', 'my-app-abc.a.run.app', 'my-app-abc.a.run.app:443']) assert.equal(await status(ok), 200, ok);
  for (const bad of ['localhost.', 'localhost.:80', 'my-app.a.run.app.', 'localhost:80@evil.com', 'evil.com@localhost', 'user:pw@localhost', 'localhost:', 'localhost:abc', 'localhost:80x', 'localhost:0', 'localhost:65536', 'localhost:123456',
    'localhost:80:80', 'localhost/evil', 'localhost\\evil', 'local host', 'localhost,evil.com', 'localhost%00.evil', '.run.app', 'evilrun.app', 'run.app', 'x.run.app.evil.com', 'a..run.app', '[::2]', '[::ffff:127.0.0.1]', '0.0.0.0', 'localhost.evil.com'])
    assert.equal(await status(bad), 400, JSON.stringify(bad));
});

// ---------- N4: malformed request lines ----------
const rawRequest = (port, text) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
  let d = ''; const done = () => { sock.destroy(); resolve(d); };
  sock.on('data', (c) => { d += c; }); sock.on('close', done); sock.on('error', done);
  setTimeout(done, 1500).unref();
});
const statusOf = (resp) => Number((/^HTTP\/1\.[01] (\d{3})/.exec(resp) || [])[1] || 0);

test('N4: malformed or hostile request lines get a 4xx JSON (or a closed socket), never a 5xx and never an error-level log line', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-')); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  const logs = []; const s = await boot({ cfg: { dist }, logs });
  const odd = ['//', 'http://', 'http://evil.com/api/health', '/\\', '\\', '*', '', ' ', '/ ', '/api/ users', '/api/users/%', '/api/users/%zz', '/api/users/%e0%a4%a', '/%', '/%00', '/%c0%af', '/api/%2e%2e/%2e%2e/etc/passwd',
    '/..', '/../../etc/passwd', '/api/overrides/%', '/api/users?range=%', '/api/users?%=%', '/api/users#frag', '//evil.com/x', '///', '/\\evil.com', '/\t', '/a\u0000b', 'ftp://x/y', 'HTTP/1.1', '/?', '/??',
    '/api/users/' + 'a'.repeat(5000), '/' + 'b'.repeat(70000), '/api/users?' + 'q=1&'.repeat(3000),
    '/api/users/é', '/api/users/%ff%fe', '/api/audit?limit=NaN', '/api/audit?limit=1e999', '/api/users?range[]=7d', '/api/health?x=' + 'a'.repeat(1900)];
  const lines = odd.map((t) => `GET ${t} HTTP/1.1`);
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = ['/', '/', '/', 'api', 'users', '%', '%2f', '%5c', '..', '.', '\\', '?', '&', '=', '#', ':', '@', '*', '//', 'a', 'u1', '0', ' ', '%00', '%zz', ';', '[', ']', '{', '}', '~', '"', "'"];
  for (let i = 0; i < 260; i++) { let t = ''; for (let k = 0, n = 1 + rnd(8); k < n; k++) t += alphabet[rnd(alphabet.length)]; lines.push(`${['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'FOO'][rnd(7)]} ${t} HTTP/1.1`); }
  lines.push('GET /api/users HTTP/9.9', 'GET /api/users', 'GET', '', 'G\u0000T / HTTP/1.1', 'GET /api/users HTTP/1.1 extra', 'GET  /api/users  HTTP/1.1');
  const bad = [];
  for (const line of lines) {
    const resp = await rawRequest(s.port, `${line}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    const code = statusOf(resp);
    if (code >= 500 || (code === 0 && resp !== '')) bad.push(`${JSON.stringify(line.slice(0, 60))} -> ${code}`);
    if (code >= 400 && code < 500 && !line.startsWith('HEAD ') && /\r\ncontent-type: application\/json/i.test(resp)) assert.match(resp, /"error":"[^"]+"/, line.slice(0, 60));
  }
  assert.deepEqual(bad, []);
  assert.ok(lines.length >= 300);
  assert.deepEqual(logs.filter((l) => l.evt === 'error'), [], 'no error-level log lines from bad requests');
  for (const t of ['//', 'http://evil.com/api/health', '/\\', '*']) { const r = await rawRequest(s.port, `GET ${t} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`); assert.equal(statusOf(r), 400, t); assert.match(r, /"error":"bad request"/, t); }
  assert.equal((await s.call('GET', '/api/health')).status, 200, 'server still healthy');
});

// ---------- N8 ----------
test('N8: reasons lose tag characters, variation selectors, invisible fillers and long stacks of combining marks; odd spaces become one space', () => {
  assert.equal(cleanReason('go\u{E0041}\u{E0042}od\u{E007F} reason'), 'good reason');
  assert.equal(cleanReason('a️b\u{E0100}c͏dㅤe⠀fᅟg'), 'abcdefg');
  assert.equal(cleanReason('one   　two'), 'one two');
  assert.equal(cleanReason('e' + '́'.repeat(12)), 'é́́');
  assert.equal(cleanReason('plain text, with punctuation: #42 (ok)'), 'plain text, with punctuation: #42 (ok)');
  assert.equal(cleanReason('résumé café 日本語'), 'résumé café 日本語');
});

test('N8: gateway error text that looks like a credential or a URL is never shown, even to an admin', async () => {
  const s = await boot(); const token = await s.login();
  s.gw.listLimits = async () => [];
  for (const text of ['Bearer abc123 rejected', 'bad token eyJhbGciOi', 'Authorization header missing', 'invalid X-API-Key', 'see https://gw.internal/docs', 'http://10.0.0.1 refused']) {
    s.gw.upsert = async () => { throw new HttpError(400, text); };
    const r = await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'gateway error', text);
  }
  s.gw.upsert = async () => { throw new HttpError(400, 'limit already exists'); };
  assert.equal((await s.call('PUT', '/api/users/u1/budget', { token, body: { period: 'weekly', action: 'set', usd: 5 } })).json.error, 'limit already exists');
});
