import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.mjs';
import { DEMO_ADMIN } from '../lib/demo-users.mjs';
import crypto from 'node:crypto';
import { SCHEDULER_AUDIENCE, SCHEDULER_SA, SECRETS, fakeClock, silent, testCfg } from './api-helpers.mjs';
import { EVIL, GOOD, fakeGoogle, makeKey, jwkOf, signJwt } from './security-fixtures.mjs';

const req = (headers = {}) => ({ headers });
const withToken = (t) => req({ 'x-app-token': t });
const rejects401 = (fn) => assert.throws(fn, (e) => e.status === 401);
const mk = (patch = {}, env = {}) => { const clock = fakeClock(); const auth = createAuth(testCfg(env, patch), { now: clock.now, log: silent }); return { clock, auth }; };

test('accounts mode: login ok, case-insensitive email, token round trip with per-admin key', () => {
  const { auth } = mk();
  const r = auth.login({ email: '  ADA@example.com ', password: SECRETS.adaPw });
  assert.equal(r.email, 'ada@example.com'); assert.equal(r.name, 'Ada Admin'); assert.match(r.token, /^[\w-]+\.[\w-]+$/);
  const a = auth.requireAdmin(withToken(r.token));
  assert.deepEqual(a, { email: 'ada@example.com', name: 'Ada Admin', writeKey: SECRETS.adaKey });
  const bob = auth.requireAdmin(withToken(auth.login({ email: 'bob@example.com', password: SECRETS.bobPw }).token));
  assert.equal(bob.writeKey, SECRETS.bobKey); assert.equal(bob.name, 'bob');
  assert.equal(auth.accounts, true);
});

test('wrong password and unknown email give the identical error', () => {
  const { auth } = mk();
  const grab = (body) => { try { auth.login(body); } catch (e) { return { status: e.status, message: e.message }; } };
  const a = grab({ email: 'ada@example.com', password: 'nope' }), b = grab({ email: 'ghost@example.com', password: SECRETS.adaPw });
  const c = grab({ email: 'ada@example.com' }), d = grab({}), e = grab({ email: ['x'], password: { a: 1 } });
  assert.deepEqual(a, { status: 401, message: 'wrong email or password' });
  for (const x of [b, c, d, e]) assert.deepEqual(x, a);
});

test('rate limit: 5 failures per minute, window slides, successes do not count', () => {
  const { auth, clock } = mk();
  const bad = () => { try { auth.login({ email: 'ada@example.com', password: 'x' }); } catch (e) { return e.status; } };
  auth.login({ email: 'ada@example.com', password: SECRETS.adaPw });
  for (let i = 0; i < 5; i++) assert.equal(bad(), 401);
  assert.equal(bad(), 429);
  assert.throws(() => auth.login({ email: 'ada@example.com', password: SECRETS.adaPw }), (e) => e.status === 429, 'even the right password is refused while limited');
  clock.advance(61e3);
  assert.ok(auth.login({ email: 'ada@example.com', password: SECRETS.adaPw }).token);
  assert.equal(bad(), 401);
});

test('tokens: expiry after 12h, tampering, garbage, wrong secret, removed account', () => {
  const { auth, clock } = mk();
  const { token } = auth.login({ email: 'ada@example.com', password: SECRETS.adaPw });
  assert.ok(auth.optionalAdmin(withToken(token)));
  clock.advance(11.9 * 3600e3); assert.ok(auth.optionalAdmin(withToken(token)));
  clock.advance(0.2 * 3600e3); assert.equal(auth.optionalAdmin(withToken(token)), null, 'expired');

  const fresh = mk();
  const t = fresh.auth.login({ email: 'ada@example.com', password: SECRETS.adaPw }).token;
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: fresh.clock.t + 1e9, email: 'bob@example.com', name: 'x' })).toString('base64url');
  for (const bad of [forged + '.' + s, p + '.' + s.slice(0, -2) + 'AA', p + '.', '.' + s, p, '', 'a.b.c', p + '.' + s + '.x', 'null', '{}']) assert.equal(fresh.auth.optionalAdmin(withToken(bad)), null, bad.slice(0, 20));
  rejects401(() => fresh.auth.requireAdmin(req()));
  rejects401(() => fresh.auth.requireAdmin(withToken('')));
  // a token signed with another secret
  const other = createAuth(testCfg({ APP_SESSION_SECRET: 'a-different-secret-0123456789-abcdefghij' }), { now: fresh.clock.now, log: silent });
  assert.equal(other.optionalAdmin(withToken(t)), null);
  // an admin removed from config loses their sessions
  const removed = createAuth(testCfg({ APP_ADMINS: JSON.stringify([{ email: 'bob@example.com', password: 'a-long-enough-password', writeKey: 'k' }]) }), { now: fresh.clock.now, log: silent });
  assert.equal(removed.optionalAdmin(withToken(t)), null);
});

test('Authorization: Bearer works for a session but a Google-style 3-part token is never a session', () => {
  const { auth } = mk();
  const { token } = auth.login({ email: 'ada@example.com', password: SECRETS.adaPw });
  assert.ok(auth.optionalAdmin(req({ authorization: 'Bearer ' + token })));
  assert.equal(auth.optionalAdmin(req({ authorization: 'Bearer ' + token + '.extra' })), null);
  assert.ok(auth.optionalAdmin(req({ authorization: 'Bearer google.id.token', 'x-app-token': token })), 'x-app-token wins');
});

test('local single-admin mode', () => {
  const env = { APP_ADMINS: '', APP_ADMIN_PASSWORD: SECRETS.localPw, GATEWAY_ADMIN_WRITE_KEY: SECRETS.localKey };
  const { auth } = mk({}, env);
  assert.equal(auth.accounts, false);
  assert.throws(() => auth.login({ password: 'wrong' }), (e) => e.status === 401 && e.message === 'wrong password');
  const r = auth.login({ password: SECRETS.localPw });
  assert.equal(r.email, 'local-admin');
  assert.deepEqual(auth.requireAdmin(withToken(r.token)), { email: 'local-admin', name: 'Admin', writeKey: SECRETS.localKey });
  assert.equal(auth.login({ email: 'whoever', password: SECRETS.localPw }).email, 'local-admin');
});

test('demo mode: the documented demo admin signs in, nobody else', () => {
  const { auth } = mk({ demo: true, admins: [], localPassword: '', writeKey: '' });
  assert.equal(auth.accounts, true);
  const r = auth.login({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password });
  assert.equal(r.name, DEMO_ADMIN.name);
  assert.ok(auth.requireAdmin(withToken(r.token)).writeKey);
  assert.throws(() => auth.login({ email: DEMO_ADMIN.email, password: 'x' }), (e) => e.status === 401);
  // a non-demo config with no accounts never lets anyone in
  const none = createAuth(testCfg({}, { admins: [], localPassword: '', demo: false }), { log: silent });
  assert.throws(() => none.login({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password }), (e) => e.status === 401);
});

// ---------- scheduler ----------
const bearer = (t) => req({ authorization: 'Bearer ' + t });
const cloud = (patch = {}, google = fakeGoogle()) => {
  const clock = fakeClock();
  const auth = createAuth(testCfg({}, { inCloud: true, ...patch }), { now: clock.now, log: silent, fetch: google.fetch });
  return { auth, clock, google };
};
const rejects = async (auth, token, name) => assert.rejects(() => auth.requireScheduler(bearer(token)), (e) => e.status === 401, name);

test('scheduler: accepts a properly signed Google ID token for exactly SCHEDULER_SA and SCHEDULER_AUDIENCE', async () => {
  const { auth, clock, google } = cloud();
  assert.deepEqual(await auth.requireScheduler(bearer(signJwt(clock))), { via: 'scheduler', email: SCHEDULER_SA });
  assert.equal((await auth.requireScheduler(bearer(signJwt(clock, { iss: 'accounts.google.com', email: SCHEDULER_SA.toUpperCase() })))).via, 'scheduler');
  assert.equal(google.calls, 1, 'JWKS fetched once and cached');
  assert.deepEqual(google.urls, ['https://www.googleapis.com/oauth2/v3/certs']);
});

test('scheduler: a token with a forged signature or claims-only body is refused (regression: it used to be trusted)', async () => {
  const { auth, clock } = cloud();
  const good = signJwt(clock);
  const [h, c] = good.split('.');
  await rejects(auth, `${h}.${c}.c2lnbmF0dXJl`, 'garbage signature');
  await rejects(auth, signJwt(clock, {}, { pair: EVIL }), 'signed by another key under the real kid');
  await rejects(auth, signJwt(clock, {}, { pair: EVIL, kid: 'evil-kid' }), 'signed by another key under an unknown kid');
  // claims edited after signing
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(c, 'base64url')), exp: Math.floor(clock.t / 1000) + 99999 })).toString('base64url');
  await rejects(auth, `${h}.${other}.${good.split('.')[2]}`, 'claims changed after signing');
  await rejects(auth, signJwt(clock, {}, { alg: 'none' }), 'alg none');
  await rejects(auth, signJwt(clock, {}, { alg: 'HS256', sig: crypto.createHmac('sha256', 'x').update('y').digest('base64url') }), 'HS256');
  await rejects(auth, signJwt(clock, {}, { kid: null }), 'no kid');
});

test('scheduler: rejects every claim near miss even when correctly signed', async () => {
  const { auth, clock } = cloud();
  const nowS = Math.floor(clock.t / 1000);
  const cases = {
    'other service account': { email: 'attacker@proj.iam.gserviceaccount.com' },
    'email unverified': { email_verified: false }, 'email_verified missing': { email_verified: undefined },
    'email_verified a string': { email_verified: 'true' },
    'wrong issuer': { iss: 'https://evil.example.com' }, 'issuer missing': { iss: undefined },
    'wrong audience': { aud: 'https://other.run.app' }, 'audience missing': { aud: undefined }, 'audience array': { aud: [SCHEDULER_AUDIENCE] },
    expired: { exp: nowS - 1 }, 'exp missing': { exp: undefined }, 'exp as string': { exp: String(nowS + 99) },
    'iat missing': { iat: undefined }, 'iat in the future': { iat: nowS + 600 }, 'lifetime over 24h': { iat: nowS - 5, exp: nowS + 90000 },
    'no email': { email: undefined }, 'email as array': { email: [SCHEDULER_SA] },
    'suffix trick': { email: SCHEDULER_SA + '.evil.com' }, 'prefix trick': { email: 'x' + SCHEDULER_SA },
  };
  for (const [name, claims] of Object.entries(cases)) await rejects(auth, signJwt(clock, claims), name);
  for (const t of ['abc', 'a.b', 'xx.yy.zz', signJwt(clock) + '.x', '']) await rejects(auth, t, t.slice(0, 12));
  await assert.rejects(() => auth.requireScheduler(req()), (e) => e.status === 401);
  await assert.rejects(() => auth.requireScheduler(req({ authorization: 'Basic abc' })), (e) => e.status === 401);
});

test('scheduler: fails closed with no SCHEDULER_SA or no SCHEDULER_AUDIENCE, and a JWKS outage never lets anything in', async () => {
  const claimsFor = (clock, email) => signJwt(clock, { email });
  const a = cloud({ schedulerSa: '' });
  for (const email of ['', undefined, 'anything@x.com', null]) await rejects(a.auth, claimsFor(a.clock, email));
  const b = cloud({ schedulerAudience: '' });
  await rejects(b.auth, signJwt(b.clock), 'no audience configured');
  await rejects(b.auth, signJwt(b.clock, { aud: '' }), 'empty audience');
  assert.equal(b.google.calls, 0, 'nothing was fetched for a service that is not configured');
  const down = cloud({}, fakeGoogle()); down.google.fail = true;
  await rejects(down.auth, signJwt(down.clock), 'JWKS unreachable and nothing cached');
});

test('scheduler: JWKS is cached for an hour, refreshed after, a rotated key is picked up at most once a minute, an outage uses the cached copy', async () => {
  const { auth, clock, google } = cloud();
  await auth.requireScheduler(bearer(signJwt(clock)));
  clock.advance(30 * 60e3); await auth.requireScheduler(bearer(signJwt(clock)));
  assert.equal(google.calls, 1);
  clock.advance(31 * 60e3); await auth.requireScheduler(bearer(signJwt(clock)));
  assert.equal(google.calls, 2, 'expired after an hour');
  // key rotation: Google publishes a new key and signs with it
  clock.advance(61e3);
  const next = makeKey(); google.keys = [jwkOf(GOOD, 'good-kid'), jwkOf(next, 'next-kid')];
  assert.equal((await auth.requireScheduler(bearer(signJwt(clock, {}, { pair: next, kid: 'next-kid' })))).via, 'scheduler');
  assert.equal(google.calls, 3);
  // unknown kids cannot make us hammer Google
  for (let i = 0; i < 20; i++) await rejects(auth, signJwt(clock, {}, { pair: EVIL, kid: 'junk' + i }));
  assert.ok(google.calls <= 4, 'at most one refetch per minute: ' + google.calls);
  // outage after expiry: the stale copy still verifies real tokens
  clock.advance(2 * 3600e3); google.fail = true;
  assert.equal((await auth.requireScheduler(bearer(signJwt(clock)))).via, 'scheduler');
  clock.advance(6 * 3600e3);
  await rejects(auth, signJwt(clock), 'stale for too long: fail closed');
});

test('scheduler: tokens are not accepted off Cloud Run', async () => {
  const { auth, clock } = mk({ inCloud: false });
  await rejects(auth, signJwt(clock));
});

test('scheduler: an admin session is also accepted', async () => {
  const { auth } = mk();
  const { token } = auth.login({ email: 'ada@example.com', password: SECRETS.adaPw });
  assert.deepEqual(await auth.requireScheduler(withToken(token)), { via: 'admin', email: 'ada@example.com' });
});
