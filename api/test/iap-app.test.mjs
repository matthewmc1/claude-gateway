// The budget app in APP_AUTH_MODE=iap over real HTTP: the signed JWT is the perimeter, every write needs same-origin proof,
// password sessions do not exist. Ports 19180-19199 (19199 is the local key-server test).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../lib/routes.mjs';
import { SECRETS, fakeClock, fakeUsage, memStore, personal, seededGateway } from './api-helpers.mjs';
import { ADA, GOOD, IAP_AUD, VIEWER, fakeIapKeys, iapCfg, signIap } from './iap-fixtures.mjs';

let nextPort = 19180;
const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
async function listenFree(server) {
  for (let i = 0; i < 20; i++) {
    const port = nextPort; nextPort = nextPort >= 19198 ? 19180 : nextPort + 1;
    try { await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); ok(); }); }); return port; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free test port in 19180-19198');
}

async function boot({ env = {}, patch = {}, logs = [], keys = fakeIapKeys(), noFetch = false } = {}) {
  const clock = fakeClock();
  const gw = await seededGateway(clock);
  const cfg = iapCfg(env, { usageSource: 'none', ...patch });
  const usage = fakeUsage({ roster: new Map([['u1', 'u1@example.com']]), users: [{ sub: 'u1', email: 'u1@example.com', requests: 5, ok: 5, lastSeen: null, models: [] }] });
  const app = createApp(cfg, { now: clock.now, gateway: gw, store: memStore(), usage, log: (o) => logs.push(o), lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0, ...(noFetch ? {} : { fetch: keys.fetch }) });
  const port = await listenFree(app.server);
  closers.push(() => app.close());
  const jwt = (email, claims = {}, o) => signIap(clock, { email, ...claims }, o);
  // `as` = who IAP says it is; `post` adds the same-origin proof a real browser page would send.
  const call = (method, p, { as, body, headers = {}, same = method !== 'GET' } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const host = headers.host || `127.0.0.1:${port}`;
    const h = { ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...(as ? { 'x-goog-iap-jwt-assertion': as.startsWith('ey') ? as : jwt(as) } : {}),
      ...(same ? { 'x-app-csrf': '1', origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, setHost: !('host' in h) }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text: t, json }); });
    });
    req.on('error', reject); req.end(payload);
  });
  return { app, clock, gw, port, call, cfg, logs, jwt, keys, usage };
}
const orgBudget = { period: 'weekly', action: 'set', usd: 200 };

test('no IAP header: nothing is served, not even open-view data; /healthz is the only open door', async () => {
  const { call, logs } = await boot();
  for (const p of ['/api/health', '/api/users', '/api/company', '/api/models', '/api/audit', '/api/overrides', '/api/users/u1']) {
    const r = await call('GET', p); assert.equal(r.status, 401, p); assert.match(r.json.error, /IAP|sign-in/);
  }
  const h = await call('GET', '/healthz'); assert.equal(h.status, 200); assert.equal(h.text, 'ok\n');
  assert.equal((await call('GET', '/healthz', { headers: { host: '10.1.2.3:8080' } })).status, 200, 'probes carry the instance address');
  assert.equal((await call('GET', '/api/users', { as: '' })).status, 401);
  assert.equal((await call('GET', '/api/users', { as: 'garbage.jwt.here' })).status, 401);
  assert.ok(logs.some((l) => l.evt === 'iap.denied' && l.reason === 'missing'));
});
test('forged unsigned x-goog-authenticated-user-* headers never identify anyone (and are logged once as a misconfiguration)', async () => {
  const { call, logs } = await boot();
  const forged = { 'x-goog-authenticated-user-email': `accounts.google.com:${ADA}`, 'x-goog-authenticated-user-id': 'accounts.google.com:1' };
  assert.equal((await call('GET', '/api/users', { headers: forged })).status, 401);
  assert.equal((await call('PUT', '/api/org/budget', { headers: forged, body: orgBudget })).status, 401);
  assert.equal((await call('GET', '/api/health', { headers: forged })).status, 401);
  assert.equal(logs.filter((l) => l.evt === 'iap.misconfigured').length, 1);
  // with a valid viewer JWT the forged admin header changes nothing
  const r = await call('PUT', '/api/org/budget', { as: VIEWER, headers: forged, body: orgBudget });
  assert.equal(r.status, 403);
});
test('invalid tokens are 401: expired, wrong audience, wrong issuer, wrong alg, unknown key, tampered', async () => {
  const { call, clock, jwt } = await boot();
  const n = Math.floor(clock.t / 1000);
  const good = jwt(ADA);
  assert.equal((await call('GET', '/api/users', { as: good })).status, 200);
  const [h, p, s] = good.split('.');
  const bad = [jwt(ADA, { iat: n - 1200, exp: n - 600 }), jwt(ADA, { aud: '/projects/1/locations/x/services/y' }), jwt(ADA, { iss: 'https://accounts.google.com' }), jwt(ADA, {}, { alg: 'HS256' }),
    jwt(ADA, {}, { kid: 'nope' }), `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'z@example.com' })).toString('base64url')}.${s}`];
  for (const t of bad) assert.equal((await call('GET', '/api/users', { as: t })).status, 401);
});
test('viewer: reads work (view access open), health reports iap mode and identity, no admin', async () => {
  const { call } = await boot();
  const u = await call('GET', '/api/users', { as: VIEWER }); assert.equal(u.status, 200); assert.ok(u.json.users.length);
  const h = await call('GET', '/api/health', { as: VIEWER });
  assert.equal(h.json.auth, 'iap'); assert.equal(h.json.admin, null); assert.deepEqual(h.json.identity, { email: VIEWER, name: 'eve', admin: false });
  assert.equal(h.json.viewAccess, 'open');
});
test('admin: identity from the verified email (any letter case), no password anywhere', async () => {
  const { call } = await boot();
  const h = await call('GET', '/api/health', { as: 'ADA@EXAMPLE.COM' });
  assert.deepEqual(h.json.identity, { email: ADA, name: 'Ada Admin', admin: true }); assert.deepEqual(h.json.admin, { email: ADA, name: 'Ada Admin' });
  assert.equal((await call('GET', '/api/health', { as: 'bob@example.com' })).json.identity.admin, true, 'an admin entry that does have a password');
});
test('non-admin write is 403 and changes nothing; admin write works and is attributed to the admin', async () => {
  const { call, gw } = await boot();
  assert.equal((await call('PUT', '/api/org/budget', { as: VIEWER, body: orgBudget })).status, 403);
  assert.equal((await call('PUT', '/api/users/u1/budget', { as: VIEWER, body: { period: 'weekly', action: 'set', usd: 1 } })).status, 403);
  assert.equal((await call('POST', '/api/overrides', { as: VIEWER, body: {} })).status, 403);
  assert.equal((await call('DELETE', '/api/overrides/ovr_000000000000', { as: VIEWER })).status, 403);
  assert.equal((await call('POST', '/api/overrides/ovr_000000000000/retry', { as: VIEWER })).status, 403);
  assert.equal((await gw.listLimits()).find((l) => l.scope.type === 'organization' && l.period === 'weekly').amount, '15000');
  const ok = await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget }); assert.equal(ok.status, 200);
  assert.equal((await gw.listLimits()).find((l) => l.scope.type === 'organization' && l.period === 'weekly').amount, '20000');
  assert.equal((await gw.audit(1))[0].actor, 'admin-key:' + ADA);
  assert.equal((await call('PUT', '/api/users/u1/budget', { as: ADA, body: { period: 'weekly', action: 'set', usd: 12.5 } })).status, 200);
  assert.equal(personal(gw, 'u1', 'weekly').amount, '1250');
});
test('CSRF: every non-GET needs x-app-csrf: 1', async () => {
  const { call } = await boot();
  for (const v of [undefined, '0', 'true', '', '1, 1', 'yes']) {
    const r = await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, headers: { 'x-app-csrf': v } });
    assert.equal(r.status, 403, String(v)); assert.match(r.json.error, /cross-site|non-browser/);
  }
  assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget })).status, 200);
  // the header alone is not enough: at least one browser-supplied same-origin proof (Origin equal to the Host, or Sec-Fetch-Site: same-origin) must come with it
  const alone = await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false, headers: { 'x-app-csrf': '1' } });
  assert.equal(alone.status, 403); assert.match(alone.json.error, /cross-site|non-browser/);
  assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false, headers: { 'x-app-csrf': '1', 'sec-fetch-site': 'none' } })).status, 403, 'none is a typed URL, not a same-origin write');
  assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false, headers: { 'x-app-csrf': '1', 'sec-fetch-site': 'same-origin' } })).status, 200, 'Sec-Fetch-Site alone is a proof');
});
test('CSRF: Origin equal to the Host is a proof on its own (browsers without Fetch Metadata); a wrong Origin fails even next to same-origin', async () => {
  const { call, port } = await boot();
  assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false, headers: { 'x-app-csrf': '1', origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false, headers: { 'x-app-csrf': '1', origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' } })).status, 403);
});
test('Fetch Metadata on EVERY /api request: cross-site and same-site are refused (reads too, before the JWT is even looked at); none, same-origin and absent pass', async () => {
  const { call } = await boot();
  const paths = ['/api/health', '/api/users', '/api/users/u1', '/api/users/nobody', '/api/company', '/api/models', '/api/audit', '/api/overrides'];
  for (const sfs of ['cross-site', 'same-site', 'Cross-Site', '', 'weird']) {
    for (const p of paths) {
      assert.equal((await call('GET', p, { as: ADA, headers: { 'sec-fetch-site': sfs } })).status, 403, `${p} sfs=${sfs}`);
      assert.equal((await call('GET', p, { headers: { 'sec-fetch-site': sfs } })).status, 403, `${p} sfs=${sfs} without a JWT: 403, not a 401 that distinguishes anything`);
    }
  }
  assert.equal((await call('GET', '/api/users/nobody', { as: ADA, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'an unknown sub answers like a known one cross-site: no XS-Leak');
  for (const sfs of ['same-origin', 'none', undefined]) for (const p of paths.filter((x) => x !== '/api/users/nobody')) assert.equal((await call('GET', p, { as: ADA, headers: { 'sec-fetch-site': sfs } })).status, 200, `${p} sfs=${sfs}`);
  assert.equal((await call('HEAD', '/api/users', { as: ADA, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('GET', '/healthz', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'probes and the liveness page are not browser API calls');
});
test('API responses (ok and error) carry Cross-Origin-Resource-Policy: same-origin', async () => {
  const { call } = await boot();
  for (const r of [await call('GET', '/api/users', { as: ADA }), await call('GET', '/api/users'), await call('GET', '/api/users', { as: ADA, headers: { 'sec-fetch-site': 'cross-site' } }), await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, same: false })]) {
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', String(r.status));
  }
});
test('CSRF: cross-site Origin and Sec-Fetch-Site are refused on every write route, including /api/internal/tick', async () => {
  const { call, port } = await boot();
  const origins = ['https://evil.example.com', 'http://evil.example.com', 'null', `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port}.evil.com`, 'http://localhost:8081'];
  const routes = [['PUT', '/api/org/budget', orgBudget], ['PUT', '/api/users/u1/budget', orgBudget], ['POST', '/api/overrides', {}], ['DELETE', '/api/overrides/ovr_000000000000'],
    ['POST', '/api/overrides/ovr_000000000000/retry'], ['POST', '/api/internal/tick', {}], ['POST', '/api/login', {}], ['POST', '/api/logout', {}]];
  for (const [m, p, body] of routes) {
    for (const origin of origins) assert.equal((await call(m, p, { as: ADA, body, headers: { origin } })).status, 403, `${m} ${p} ${origin}`);
    for (const sfs of ['cross-site', 'same-site', '', 'Cross-Site']) assert.equal((await call(m, p, { as: ADA, body, headers: { 'sec-fetch-site': sfs } })).status, 403, `${m} ${p} sfs=${sfs}`);
  }
  for (const sfs of ['same-origin', 'none']) assert.equal((await call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, headers: { 'sec-fetch-site': sfs } })).status, 200, sfs);
  const tick = await call('POST', '/api/internal/tick', { as: ADA, body: {} }); assert.equal(tick.status, 200); assert.ok(tick.json.overrides);
  assert.equal((await call('POST', '/api/internal/tick', { as: VIEWER, body: {} })).status, 403, 'a viewer cannot tick');
  assert.equal((await call('POST', '/api/internal/tick', { as: ADA, body: {}, headers: { 'x-app-csrf': undefined } })).status, 403);
  assert.equal((await call('POST', '/api/internal/tick', { body: {} })).status, 401, 'no JWT');
});
test('cross-origin reads are refused too, and a preflight is never granted', async () => {
  const { call } = await boot();
  assert.equal((await call('GET', '/api/users', { as: ADA, headers: { origin: 'https://evil.example.com' } })).status, 403);
  const pre = await call('OPTIONS', '/api/org/budget', { headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-app-csrf' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], undefined, 'no CORS grant: the custom header cannot be sent cross-site');
});
test('on Cloud Run only https://<Host> counts as same origin; a custom domain works when Host and Origin agree and the host is allowed', async () => {
  const { call } = await boot({ patch: { inCloud: true }, env: { APP_ALLOWED_HOSTS: 'budget.corp.example.com' } });
  const host = 'budget.corp.example.com';
  const w = (origin, extra = {}) => call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, headers: { host, origin, ...extra } });
  assert.equal((await w(`https://${host}`)).status, 200, 'https origin equal to the Host');
  assert.equal((await w(`https://${host.toUpperCase()}`)).status, 403, 'browsers send lower case; anything else is not equal');
  assert.equal((await w(`http://${host}`)).status, 403, 'plain http is not the public origin on Cloud Run');
  assert.equal((await w('https://claude-budget-app-abc.a.run.app')).status, 403, 'the run.app address while the browser is on the custom domain');
  assert.equal((await w('https://evil.example.com')).status, 403);
  assert.equal((await w(`https://${host}`, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('GET', '/api/users', { as: ADA, headers: { host: 'other.example.com' } })).status, 400, 'a Host nobody allowed is refused before auth');
});
test('IAP on Cloud Run: the loopback Host names are not accepted by default (only the listed hosts); off Cloud Run they still are', async () => {
  const cloud = await boot({ env: { K_SERVICE: 'claude-budget-app', APP_ALLOWED_HOSTS: 'Budget.Corp.Example.com' } });
  for (const host of ['localhost', 'localhost:8080', '127.0.0.1:8080', '[::1]:8080']) assert.equal((await cloud.call('GET', '/api/users', { as: ADA, headers: { host } })).status, 400, host);
  assert.equal((await cloud.call('GET', '/api/users', { as: ADA, headers: { host: 'budget.corp.example.com' } })).status, 200, 'the listed host (any letter case in the setting)');
  assert.equal((await cloud.call('GET', '/healthz', { headers: { host: 'localhost' } })).status, 200, 'probes never depended on it');
  const local = await boot();
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) assert.equal((await local.call('GET', '/api/users', { as: ADA, headers: { host } })).status, 200, host);
});
test('APP_ALLOWED_ORIGINS adds a front-end origin whose Host differs (a rewriting proxy), still with the header', async () => {
  const { call } = await boot({ patch: { inCloud: true }, env: { APP_ALLOWED_HOSTS: 'budget.corp.example.com', APP_ALLOWED_ORIGINS: 'https://front.corp.example.com' } });
  const r = (origin, csrf = '1') => call('PUT', '/api/org/budget', { as: ADA, body: orgBudget, headers: { host: 'budget.corp.example.com', origin, 'x-app-csrf': csrf } });
  assert.equal((await r('https://front.corp.example.com')).status, 200);
  assert.equal((await r('https://front.corp.example.com', '0')).status, 403);
});
test('there is exactly one way in: password login and logout are gone (410) and x-app-token means nothing', async () => {
  const { call, app } = await boot();
  assert.equal((await call('POST', '/api/login', { as: ADA, body: { email: ADA, password: SECRETS.bobPw } })).status, 410);
  assert.equal((await call('POST', '/api/login', { body: { email: 'bob@example.com', password: SECRETS.bobPw } })).status, 401, 'without a JWT it is the perimeter that answers');
  assert.equal((await call('POST', '/api/logout', { as: ADA, body: {} })).status, 410);
  assert.throws(() => app.auth.login({ email: 'bob@example.com', password: SECRETS.bobPw }), (e) => e.status === 410);
  // a perfectly valid app session token (minted by hand) is ignored: a viewer with it is still a viewer, no JWT is still nobody
  const sess = app.auth.mint('bob@example.com', 'bob');
  assert.equal(app.auth.verify(sess), null);
  assert.equal((await call('PUT', '/api/org/budget', { as: VIEWER, body: orgBudget, headers: { 'x-app-token': sess } })).status, 403);
  assert.equal((await call('PUT', '/api/org/budget', { body: orgBudget, headers: { 'x-app-token': sess } })).status, 401);
  assert.equal((await call('GET', '/api/users', { headers: { authorization: 'Bearer ' + sess } })).status, 401);
  assert.equal((await call('GET', '/api/health', { as: VIEWER, headers: { 'x-app-token': sess } })).json.admin, null);
});
test('the Cloud Scheduler token path is closed in iap mode', async () => {
  const { call } = await boot({ patch: { inCloud: true }, env: { SCHEDULER_SA: 'sched@p.iam.gserviceaccount.com', SCHEDULER_AUDIENCE: 'https://x.a.run.app' } });
  const r = await call('POST', '/api/internal/tick', { headers: { authorization: 'Bearer aaa.bbb.ccc', origin: undefined } });
  assert.equal(r.status, 401);
});
test('APP_VIEW_ACCESS=admin: viewers get 403 on reads, admins read, health still tells a viewer who they are', async () => {
  const { call } = await boot({ env: { APP_VIEW_ACCESS: 'admin' } });
  for (const p of ['/api/users', '/api/company', '/api/models', '/api/audit', '/api/overrides', '/api/users/u1']) {
    const v = await call('GET', p, { as: VIEWER }); assert.equal(v.status, 403, p);
    assert.equal((await call('GET', p, { as: ADA })).status, 200, p);
    assert.equal((await call('GET', p)).status, 401, p);
  }
  const h = await call('GET', '/api/health', { as: VIEWER });
  assert.equal(h.status, 200); assert.equal(h.json.viewAccess, 'admin'); assert.equal(h.json.identity.admin, false);
});
test('IAP_ALLOWED_DOMAINS is enforced by the app', async () => {
  const { call, jwt } = await boot({ env: { IAP_ALLOWED_DOMAINS: 'example.com' } });
  assert.equal((await call('GET', '/api/users', { as: VIEWER })).status, 200);
  assert.equal((await call('GET', '/api/users', { as: jwt('mallory@other.com', { hd: 'other.com' }) })).status, 401);
  assert.equal((await call('GET', '/api/users', { as: jwt('mallory@example.com', { hd: undefined }) })).status, 401);
});
test('keys unavailable: 503 with Retry-After (not a 401 that would tell people they are not allowed)', async () => {
  const keys = fakeIapKeys(); keys.fail = true;
  const { call } = await boot({ keys });
  const r = await call('GET', '/api/users', { as: ADA });
  assert.equal(r.status, 503); assert.ok(r.headers['retry-after']);
  assert.equal((await call('GET', '/api/users')).status, 401, 'a request with no JWT never needs the keys');
  assert.equal((await call('GET', '/healthz')).status, 200);
});
test('keys come from the local emulator URL when IAP_PUBLIC_KEYS_URL is set (global fetch, real HTTP)', async () => {
  const k = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: fakeIapKeys().keys })); });
  await new Promise((ok) => k.listen(19199, '127.0.0.1', ok)); closers.push(() => new Promise((ok) => k.close(ok)));
  const { call } = await boot({ env: { IAP_PUBLIC_KEYS_URL: 'http://127.0.0.1:19199/keys' }, noFetch: true });
  assert.equal((await call('GET', '/api/users', { as: ADA })).status, 200);
  assert.equal((await call('GET', '/api/users', { as: 'x.y.z' })).status, 401);
});
test('session mode is untouched: x-app-csrf is not required and health says auth: session', async () => {
  const { loadConfig } = await import('../lib/config.mjs');
  const { testEnv } = await import('./api-helpers.mjs');
  const clock = fakeClock();
  const app = createApp({ ...loadConfig(testEnv()), usageSource: 'none' }, { now: clock.now, gateway: await seededGateway(clock), store: memStore(), usage: fakeUsage(), log: () => {}, lazyTickMs: 0, timerTickMs: 0, readCacheMs: 0, healthCacheMs: 0 });
  const port = await listenFree(app.server); closers.push(() => app.close());
  const get = (p) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(t) })); }));
  const h = await get('/api/health'); assert.equal(h.json.auth, 'session'); assert.equal(h.json.identity, null);
  assert.equal((await get('/api/users')).status, 200);
});
