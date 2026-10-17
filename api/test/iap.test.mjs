// IAP verifier and config: every way a token can be wrong, key caching and rotation, and what gets logged. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createIapVerifier } from '../lib/iap.mjs';
import { loadConfig } from '../lib/config.mjs';
import { H, fakeClock, silent, testEnv } from './api-helpers.mjs';
import { ADA, EVIL, GOOD, IAP_AUD, IAP_ENV, IAP_LB_AUD, fakeIapKeys, iapCfg, jwkOfEc, makeEc, signIap } from './iap-fixtures.mjs';

const mk = ({ env = {}, keys, log = silent } = {}) => {
  const clock = fakeClock(), g = keys || fakeIapKeys();
  const v = createIapVerifier(iapCfg(env), { now: clock.now, fetch: g.fetch, log });
  return { clock, g, v, tok: (claims, o) => signIap(clock, claims, o) };
};
const ok = async (t, v) => (await v.verifyToken(t));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------------------------------------------------------------- config
test('config: iap mode needs IAP_AUDIENCE in a known form; both forms work; project id (not number) is refused', () => {
  const base = IAP_ENV();
  assert.throws(() => loadConfig(testEnv({ ...base, IAP_AUDIENCE: '' })), /IAP_AUDIENCE/);
  for (const bad of ['my-project', '/projects/my-project/locations/x/services/y', '/projects/1/apps/2', IAP_AUD + '/', 'https://x.run.app', IAP_AUD.toUpperCase()]) assert.throws(() => loadConfig(testEnv({ ...base, IAP_AUDIENCE: bad })), /IAP_AUDIENCE/, bad);
  for (const good of [IAP_AUD, IAP_LB_AUD]) { const c = loadConfig(testEnv({ ...base, IAP_AUDIENCE: good })); assert.equal(c.authMode, 'iap'); assert.equal(c.iap.audience, good); assert.equal(c.iap.keysUrl, 'https://www.gstatic.com/iap/verify/public_key-jwk'); }
  assert.equal(loadConfig(testEnv()).authMode, 'session'); assert.equal(loadConfig(testEnv()).iap, null);
  assert.throws(() => loadConfig(testEnv({ APP_AUTH_MODE: 'oauth' })), /APP_AUTH_MODE/);
});
test('config: iap mode drops passwords and the session secret but needs admins; session mode still needs passwords', () => {
  const noPw = JSON.stringify([{ email: 'a@example.com', writeKey: 'k-0123456789' }]);
  const iapMin = { GATEWAY_ADMIN_READ_KEY: 'r', APP_AUTH_MODE: 'iap', IAP_AUDIENCE: IAP_AUD };
  assert.ok(loadConfig({ ...iapMin, APP_ADMINS: noPw }), 'no password, no APP_SESSION_SECRET');
  assert.throws(() => loadConfig({ ...iapMin }), /needs APP_ADMINS/);
  assert.throws(() => loadConfig({ ...iapMin, GATEWAY_ADMIN_WRITE_KEY: 'w', APP_ADMIN_PASSWORD: 'long-enough-pw' }), /needs APP_ADMINS/, 'the single shared-password mode does not exist in iap mode');
  assert.throws(() => loadConfig({ ...iapMin, APP_ADMINS: JSON.stringify([{ email: 'a@example.com' }]) }), /email, writeKey/);
  assert.throws(() => loadConfig({ ...iapMin, APP_ADMINS: JSON.stringify([{ email: 'a@example.com', writeKey: 'k', password: 'short' }]) }), /at least 12/, 'a password that is given is still checked');
  assert.throws(() => loadConfig({ GATEWAY_ADMIN_READ_KEY: 'r', APP_SESSION_SECRET: 'abcdefghij0123456789ABCDEFGHIJ-_', APP_ADMINS: noPw }), /email, password and writeKey/);
});
test('config: SCHEDULER_SA / SCHEDULER_AUDIENCE are ignored in iap mode (IAP blocks the scheduler; the Cloud Run job ticks)', () => {
  const c = loadConfig(testEnv(IAP_ENV({ SCHEDULER_SA: 'x@p.iam.gserviceaccount.com', SCHEDULER_AUDIENCE: '' })));
  assert.equal(c.schedulerSa, ''); assert.equal(c.schedulerAudience, '');
});
test('config: IAP_PUBLIC_KEYS_URL only for a local emulator, never on Cloud Run', () => {
  const e = (x) => testEnv(IAP_ENV(x));
  assert.equal(loadConfig(e({ IAP_PUBLIC_KEYS_URL: 'http://127.0.0.1:19181/keys' })).iap.keysUrl, 'http://127.0.0.1:19181/keys');
  assert.ok(loadConfig(e({ IAP_PUBLIC_KEYS_URL: 'http://localhost:19181/keys' })));
  assert.ok(loadConfig(e({ IAP_PUBLIC_KEYS_URL: 'http://[::1]:19181/keys' })));
  for (const bad of ['https://127.0.0.1/keys', 'http://evil.example.com/keys', 'http://127.0.0.1.evil.com/keys', 'http://user:pw@127.0.0.1/keys', 'http://0.0.0.0/k', 'file:///etc/passwd', 'nonsense']) assert.throws(() => loadConfig(e({ IAP_PUBLIC_KEYS_URL: bad })), /IAP_PUBLIC_KEYS_URL/, bad);
  const cloud = { K_SERVICE: 'claude-budget-app', APP_STATE_BUCKET: 'b' };
  assert.throws(() => loadConfig(e({ ...cloud, IAP_PUBLIC_KEYS_URL: 'http://127.0.0.1:19181/keys' })), /must not be set on Cloud Run/);
  assert.ok(loadConfig(e(cloud)), 'the same config without the override is fine on Cloud Run');
});
test('config fails closed: empty APP_AUTH_MODE, an IAP_ALLOWED_DOMAINS that lists nothing, plain-http gateway on Cloud Run', () => {
  assert.throws(() => loadConfig(testEnv({ APP_AUTH_MODE: '' })), /APP_AUTH_MODE is set but empty/);
  assert.throws(() => loadConfig(testEnv({ APP_AUTH_MODE: '  ' })), /APP_AUTH_MODE is set but empty/);
  assert.equal(loadConfig(testEnv()).authMode, 'session', 'unset stays the documented default');
  for (const bad of ['', ' , ', ',', ' ']) assert.throws(() => loadConfig(testEnv(IAP_ENV({ IAP_ALLOWED_DOMAINS: bad }))), /IAP_ALLOWED_DOMAINS is set but lists no domain/, JSON.stringify(bad));
  assert.deepEqual(loadConfig(testEnv(IAP_ENV())).iap.allowedDomains, [], 'unset: no extra check');
  assert.deepEqual(loadConfig(testEnv(IAP_ENV({ IAP_ALLOWED_DOMAINS: 'a.com, A.com,b.org' }))).iap.allowedDomains, ['a.com', 'b.org'], 'deduplicated');
  const cloud = { K_SERVICE: 'claude-budget-app', APP_STATE_BUCKET: 'b', APP_HOST: '0.0.0.0' };
  for (const url of ['http://gw.corp.example.com', 'http://10.1.2.3:8080', 'ftp://gw.example.com', 'not a url', 'http://localhost.evil.com']) assert.throws(() => loadConfig(testEnv({ ...cloud, GATEWAY_URL: url })), /GATEWAY_URL/, url);
  for (const url of ['https://gw.corp.example.com', 'https://claude-gateway-abc-ew.a.run.app', 'http://localhost:8791', 'http://127.0.0.1:8791', 'http://[::1]:8791']) assert.equal(loadConfig(testEnv({ ...cloud, GATEWAY_URL: url })).gatewayUrl, url, url);
  assert.equal(loadConfig(testEnv({ ...cloud })).gatewayUrl, 'http://localhost:8791', 'unset on Cloud Run keeps the loopback default');
  assert.equal(loadConfig(testEnv({ GATEWAY_URL: 'http://gw.corp.example.com' })).gatewayUrl, 'http://gw.corp.example.com', 'off Cloud Run plain http is still allowed (local stack)');
  assert.throws(() => loadConfig(testEnv({ CLOUD_RUN_JOB: 'claude-budget-tick', GATEWAY_URL: 'http://gw.corp.example.com' })), /must be https/, 'the job is Cloud Run too');
});
test('config: admin emails are trimmed and lower-cased; a duplicate after trimming is refused', () => {
  const two = (a, b) => JSON.stringify([{ email: a, writeKey: 'k1' }, { email: b, writeKey: 'k2' }]);
  const c = loadConfig(testEnv(IAP_ENV({ APP_ADMINS: JSON.stringify([{ email: '  Ada@Example.com\t', name: 'Ada', writeKey: 'k1' }, { email: 'bob@example.com', writeKey: 'k2' }]) })));
  assert.deepEqual(c.admins.map((a) => a.email), ['ada@example.com', 'bob@example.com']);
  assert.equal(c.admins[0].name, 'Ada');
  assert.equal(loadConfig(testEnv(IAP_ENV({ APP_ADMINS: JSON.stringify([{ email: ' Eve@Example.com ', writeKey: 'k1' }]) }))).admins[0].name, 'eve', 'the default name comes from the trimmed email');
  assert.throws(() => loadConfig(testEnv(IAP_ENV({ APP_ADMINS: two('ada@example.com ', 'ADA@example.com') }))), /twice/);
});
test('config: IAP_ALLOWED_DOMAINS is lower-cased and validated', () => {
  assert.deepEqual(loadConfig(testEnv(IAP_ENV({ IAP_ALLOWED_DOMAINS: ' Example.com, corp.example.org ' }))).iap.allowedDomains, ['example.com', 'corp.example.org']);
  for (const bad of ['example', 'exa mple.com', '@example.com', 'example.com/x', '*.example.com']) assert.throws(() => loadConfig(testEnv(IAP_ENV({ IAP_ALLOWED_DOMAINS: bad }))), /IAP_ALLOWED_DOMAINS/, bad);
});
test('config: a Cloud Run JOB counts as Cloud Run (APP_HOST=0.0.0.0 from the image, logs usage backend, no session-secret fallback)', () => {
  const env = { GATEWAY_ADMIN_READ_KEY: 'r', APP_HOST: '0.0.0.0', APP_STATE_BUCKET: 'b', ...IAP_ENV() };
  assert.throws(() => loadConfig(env), /refusing to listen/, 'sanity: not on Cloud Run it refuses');
  const c = loadConfig({ ...env, CLOUD_RUN_JOB: 'claude-budget-tick' });
  assert.equal(c.inCloud, true); assert.equal(c.usageSource, 'logs');
  assert.throws(() => loadConfig({ GATEWAY_ADMIN_READ_KEY: 'r', CLOUD_RUN_JOB: 'j', APP_ADMINS: JSON.stringify([{ email: 'a@example.com', password: 'a-long-password-1', writeKey: 'k' }]), GATEWAY_JWT_SECRET: 'x'.repeat(40) }), /missing APP_SESSION_SECRET/);
});
test('config: GATEWAY_CA_PEM must be certificates only; empty audience stays empty', () => {
  const { certPem } = selfSigned();
  assert.equal(loadConfig(testEnv({ GATEWAY_CA_PEM: certPem })).gatewayCaPem.trim(), certPem.trim());
  assert.equal(loadConfig(testEnv({ GATEWAY_CA_PEM: certPem.replaceAll('\n', '\\n') })).gatewayCaPem.trim(), certPem.trim(), 'literal \\n from an env file');
  assert.equal(loadConfig(testEnv()).gatewayCaPem, '');
  assert.throws(() => loadConfig(testEnv({ GATEWAY_CA_PEM: 'not a certificate' })), /GATEWAY_CA_PEM/);
  assert.throws(() => loadConfig(testEnv({ GATEWAY_CA_PEM: certPem + '-----BEGIN PRIVATE ' + 'KEY-----\nAAAA\n-----END PRIVATE ' + 'KEY-----\n' })), /GATEWAY_CA_PEM/);
  assert.equal(loadConfig(testEnv({ GATEWAY_AUDIENCE: '  ' })).gatewayAudience, '');
});
// a throwaway self-signed certificate made with node:crypto only (no openssl), enough for config parsing; the TLS tests use real ones
function selfSigned() {
  const der = Buffer.alloc(200, 7);
  const certPem = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return { certPem };
}

// ---------------------------------------------------------------- token checks
test('a valid IAP token yields the verified identity (email lower-cased, sub, hd)', async () => {
  const { v, tok } = mk();
  const t = tok({ email: 'Ada@Example.com' });
  assert.deepEqual(await ok(t, v), { email: ADA, sub: 'accounts.google.com:1234567890', hd: 'example.com', exp: JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).exp });
});
test('load-balancer audience form works the same', async () => {
  const { v, tok } = mk({ env: { IAP_AUDIENCE: IAP_LB_AUD } });
  assert.ok(await ok(tok({ aud: IAP_LB_AUD }), v));
  assert.equal(await ok(tok({ aud: IAP_AUD }), v), null);
});
test('exp and iat: 30 s skew, expired and future tokens refused', async () => {
  const { v, tok, clock } = mk();
  const n = Math.floor(clock.t / 1000);
  assert.ok(await ok(tok({ iat: n - 600, exp: n - 29 }), v), 'expired 29 s ago is inside the skew');
  assert.equal(await ok(tok({ iat: n - 600, exp: n - 31 }), v), null, 'expired 31 s ago');
  assert.equal(await ok(tok({ iat: n - 3600, exp: n - 3000 }), v), null, 'long expired');
  assert.ok(await ok(tok({ iat: n + 29, exp: n + 600 }), v), 'issued 29 s in the future is inside the skew');
  assert.equal(await ok(tok({ iat: n + 31, exp: n + 600 }), v), null, 'issued in the future');
  assert.equal(await ok(tok({ iat: n + 3600, exp: n + 4200 }), v), null, 'far future iat');
  assert.equal(await ok(tok({ nbf: n + 3600 }), v), null, 'not before');
  for (const bad of [{ exp: undefined }, { iat: undefined }, { exp: '9999999999' }, { iat: 'now' }, { exp: null }]) assert.equal(await ok(tok(bad), v), null, JSON.stringify(bad));
});
test('maximum lifetime: 10 minutes plus twice the skew; exp must be after iat', async () => {
  const { v, tok, clock } = mk();
  const n = Math.floor(clock.t / 1000);
  assert.ok(await ok(tok({ iat: n - 5, exp: n - 5 + 660 }), v), 'exactly at the limit');
  assert.equal(await ok(tok({ iat: n - 5, exp: n - 5 + 661 }), v), null);
  assert.equal(await ok(tok({ iat: n - 5, exp: n + 86400 }), v), null, 'a day-long token');
  assert.equal(await ok(tok({ iat: n, exp: n }), v), null);
  assert.equal(await ok(tok({ iat: n + 10, exp: n + 5 }), v), null);
});
test('aud must match exactly; iss must be IAP', async () => {
  const { v, tok } = mk();
  for (const aud of ['/projects/123456789012/locations/europe-west2/services/other', IAP_AUD + '/', IAP_AUD + 'x', 'x' + IAP_AUD, '', [IAP_AUD], { a: IAP_AUD }, undefined, IAP_AUD.toUpperCase(), '/projects/999/locations/europe-west2/services/claude-budget-app']) assert.equal(await ok(tok({ aud }), v), null, JSON.stringify(aud));
  for (const iss of ['https://accounts.google.com', 'https://cloud.google.com/iap/', 'cloud.google.com/iap', 'https://evil.example.com', '', undefined, ['https://cloud.google.com/iap']]) assert.equal(await ok(tok({ iss }), v), null, JSON.stringify(iss));
});
test('algorithm: only ES256. none, HS256 (public key as secret), RS256, ES384, lower-case and a missing alg are refused', async () => {
  const { v, tok, clock, g } = mk();
  const body = (head) => b64(head) + '.' + b64({ iss: 'https://cloud.google.com/iap', aud: IAP_AUD, sub: 's', email: ADA, iat: Math.floor(clock.t / 1000) - 5, exp: Math.floor(clock.t / 1000) + 500 });
  assert.equal(await ok(body({ alg: 'none', kid: 'iap-kid-1' }) + '.', v), null, 'alg none, empty signature');
  assert.equal(await ok(body({ alg: 'none', kid: 'iap-kid-1' }) + '.AAAA', v), null);
  // the classic confusion attack: HMAC "signed" with the published public key as the secret
  const pub = GOOD.publicKey.export({ type: 'spki', format: 'pem' });
  const b = body({ alg: 'HS256', kid: 'iap-kid-1' });
  assert.equal(await ok(b + '.' + crypto.createHmac('sha256', pub).update(b).digest('base64url'), v), null, 'HS256');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = body({ alg: 'RS256', kid: 'iap-kid-1' });
  assert.equal(await ok(r + '.' + crypto.sign('RSA-SHA256', Buffer.from(r), rsa.privateKey).toString('base64url'), v), null, 'RS256');
  assert.equal(await ok(tok({}, { alg: 'ES384' }), v), null, 'a valid ES256 signature under an ES384 label');
  assert.equal(await ok(tok({}, { alg: 'es256' }), v), null);
  assert.equal(await ok(tok({}, { head: { typ: 'JWT', kid: 'iap-kid-1' } }), v), null, 'no alg');
  assert.equal(await ok(tok({}, { head: { alg: 'ES256', kid: 'iap-kid-1', crit: ['exp'] } }), v), null, 'crit extensions are not understood');
  assert.equal(await ok(tok({}, { kid: null }), v), null, 'no kid');
  assert.equal(await ok(tok({}, { kid: 'k'.repeat(200) }), v), null);
  assert.equal(g.calls, 0, 'none of these cost a key fetch');
  assert.ok(await ok(tok(), v), 'the plain token is fine');
});
test('signature: tampered payload, wrong key, DER-encoded and wrong-length signatures are refused', async () => {
  const { v, tok } = mk();
  const good = tok();
  const [h, p, s] = good.split('.');
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'mallory@example.com' })).toString('base64url');
  assert.equal(await ok(`${h}.${evil}.${s}`, v), null, 'tampered payload');
  assert.equal(await ok(`${h}.${p}.${s.slice(0, -4)}AAAA`, v), null, 'tampered signature');
  assert.equal(await ok(tok({}, { pair: EVIL }), v), null, 'signed by another key under a known kid');
  const der = crypto.sign('sha256', Buffer.from(`${h}.${p}`), GOOD.privateKey).toString('base64url');   // DER, not r||s
  assert.equal(await ok(`${h}.${p}.${der}`, v), null, 'DER signature');
  assert.equal(await ok(`${h}.${p}.`, v), null);
  assert.equal(await ok(`${h}.${p}.${Buffer.alloc(63).toString('base64url')}`, v), null);
  assert.equal(await ok(`${h}.${p}.${Buffer.alloc(65).toString('base64url')}`, v), null);
  assert.equal(await ok(`${h}.${p}.${Buffer.alloc(64).toString('base64url')}`, v), null, 'all-zero signature');
  assert.ok(await ok(good, v));
});
test('malformed input: missing, empty, wrong shape, not base64url, huge', async () => {
  const { v, tok, g } = mk();
  const good = tok();
  for (const bad of [undefined, '', 'abc', 'a.b', 'a.b.c.d', '..', 'a..c', 'eyJ.eyJ.sig', good + '.extra', good.replace('.', '+'), ' ' + good, good + ' ', 'x'.repeat(5000), good + 'x'.repeat(5000), null, 7, ['a.b.c'], {}]) assert.equal(await ok(bad, v), null, String(bad).slice(0, 30));
  assert.equal(g.calls, 0);
  const notJson = 'bm90LWpzb24.bm90LWpzb24.' + Buffer.alloc(64).toString('base64url');
  assert.equal(await ok(notJson, v), null);
  const arr = b64([]) + '.' + b64([]) + '.' + Buffer.alloc(64).toString('base64url');
  assert.equal(await ok(arr, v), null);
});
test('identity claims: email must look like an address, sub must exist, email_verified false is refused', async () => {
  const { v, tok } = mk();
  for (const email of [undefined, '', 'no-at-sign', '@example.com', 'a@', 'a b@example.com', 'accounts.google.com:ada@example.com', 'a@b@c.com', 123, ['ada@example.com'], 'ada@example.com\n', 'x'.repeat(300) + '@example.com']) assert.equal(await ok(tok({ email }), v), null, JSON.stringify(email));
  for (const sub of [undefined, '', 5, null, 's'.repeat(300)]) assert.equal(await ok(tok({ sub }), v), null, JSON.stringify(sub));
  assert.equal(await ok(tok({ email_verified: false }), v), null);
  assert.equal(await ok(tok({ email_verified: 'true' }), v), null);
  assert.ok(await ok(tok({ email_verified: true }), v));
});
test('IAP_ALLOWED_DOMAINS: both the email domain and hd must be listed', async () => {
  const { v, tok } = mk({ env: { IAP_ALLOWED_DOMAINS: 'example.com,corp.example.org' } });
  assert.ok(await ok(tok(), v));
  assert.ok(await ok(tok({ email: 'z@corp.example.org', hd: 'corp.example.org' }), v));
  assert.equal(await ok(tok({ email: 'z@other.com', hd: 'example.com' }), v), null, 'email domain not listed');
  assert.equal(await ok(tok({ email: 'z@example.com', hd: 'other.com' }), v), null, 'hd not listed');
  assert.equal(await ok(tok({ email: 'z@example.com', hd: undefined }), v), null, 'no hd: a consumer account carrying a corporate-looking address');
  assert.equal(await ok(tok({ email: 'z@sub.example.com', hd: 'example.com' }), v), null, 'subdomains are not implied');
  assert.equal(await ok(tok({ email: 'z@example.com.evil.com', hd: 'example.com' }), v), null);
  const open = mk();
  assert.ok(await ok(open.tok({ email: 'z@other.com', hd: undefined }), open.v), 'no list: any verified identity');
});

// ---------------------------------------------------------------- keys
test('keys are fetched once and cached; the fetch has a timeout, no redirects and a size cap', async () => {
  const { v, tok, g, clock } = mk();
  for (let i = 0; i < 5; i++) assert.ok(await ok(tok(), v));
  assert.equal(g.calls, 1);
  assert.equal(g.urls[0], 'https://www.gstatic.com/iap/verify/public_key-jwk');
  assert.equal(g.opts[0].redirect, 'error'); assert.ok(g.opts[0].signal, 'abort signal for the timeout');
  clock.advance(H + 1000);
  assert.ok(await ok(tok(), v)); assert.equal(g.calls, 2, 'refreshed after the hour');
});
test('an oversized or malformed key document is refused (fail closed with 503, never a half-trusted set)', async () => {
  const big = fakeIapKeys(); big.body = JSON.stringify({ keys: [jwkOfEc(GOOD, 'iap-kid-1')], pad: 'x'.repeat(70000) });
  const a = mk({ keys: big });
  await assert.rejects(a.v.verifyToken(a.tok()), (e) => e.status === 503);
  for (const body of ['not json', '{}', '{"keys":"x"}', '{"keys":[]}', JSON.stringify({ keys: Array.from({ length: 30 }, (_, i) => jwkOfEc(GOOD, 'k' + i)) })]) {
    const g = fakeIapKeys(); g.body = body; const m = mk({ keys: g });
    await assert.rejects(m.v.verifyToken(m.tok()), (e) => e.status === 503, body.slice(0, 20));
  }
});
test('only P-256 signing keys count: an RSA key or a wrong-use key under the right kid is ignored', async () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  const g = fakeIapKeys([{ ...rsa, kid: 'iap-kid-1', alg: 'RS256' }, { ...jwkOfEc(GOOD, 'iap-kid-2'), use: 'enc' }, { ...jwkOfEc(GOOD, 'iap-kid-3'), alg: 'ES384' }, { ...jwkOfEc(GOOD, 'iap-kid-4'), crv: 'P-384' }, jwkOfEc(GOOD, 'iap-kid-5')]);
  const { v, tok } = mk({ keys: g });
  for (const kid of ['iap-kid-1', 'iap-kid-2', 'iap-kid-3', 'iap-kid-4']) assert.equal(await ok(tok({}, { kid }), v), null, kid);
  assert.ok(await ok(tok({}, { kid: 'iap-kid-5' }), v));
  const none = fakeIapKeys([{ ...rsa, kid: 'a' }]); const m = mk({ keys: none });
  await assert.rejects(m.v.verifyToken(m.tok({}, { kid: 'a' })), (e) => e.status === 503, 'a set with no usable key');
});
test('unknown kid: one rate-limited refetch, then rotation is picked up', async () => {
  const { v, tok, g, clock } = mk();
  const NEW = makeEc();
  assert.ok(await ok(tok(), v)); assert.equal(g.calls, 1);
  assert.equal(await ok(tok({}, { pair: NEW, kid: 'iap-kid-2' }), v), null, 'unknown kid right after a fetch: no new fetch yet'); assert.equal(g.calls, 1);
  clock.advance(61e3);
  const rotated = tok({}, { pair: NEW, kid: 'iap-kid-2' });
  assert.equal(await ok(rotated, v), null, 'unknown kid, the set has not rotated yet'); assert.equal(g.calls, 2, 'one refetch');
  for (let i = 0; i < 10; i++) assert.equal(await ok(rotated, v), null);
  assert.equal(g.calls, 2, 'a flood of unknown kids cannot make us refetch more than once a minute');
  g.keys = [jwkOfEc(GOOD, 'iap-kid-1'), jwkOfEc(NEW, 'iap-kid-2')];
  assert.equal(await ok(rotated, v), null, 'still inside the minute');
  clock.advance(61e3);
  const fresh = tok({}, { pair: NEW, kid: 'iap-kid-2' });
  assert.ok(await ok(fresh, v)); assert.equal(g.calls, 3);
  assert.ok(await ok(tok(), v), 'the old key still works');
  assert.equal(await ok(tok({}, { pair: EVIL, kid: 'iap-kid-2' }), v), null, 'the new kid with the wrong key');
});
test('key endpoint failures: stale keys keep serving for a while, then fail closed (503); a cold start with no keys is a 503', async () => {
  const { v, tok, g, clock } = mk();
  assert.ok(await ok(tok(), v));
  g.fail = true;
  clock.advance(H + 1000);
  assert.ok(await ok(tok(), v), 'stale-while-error');
  clock.advance(2 * H);
  assert.ok(await ok(tok(), v), 'still inside the stale window');
  clock.advance(4 * H);
  await assert.rejects(v.verifyToken(tok()), (e) => e.status === 503 && !!e.headers['retry-after'], 'stale window over');
  g.fail = false; clock.advance(10e3);
  assert.ok(await ok(tok(), v), 'recovers when the endpoint does');

  const cold = mk(); cold.g.fail = true;
  await assert.rejects(cold.v.verifyToken(cold.tok()), (e) => e.status === 503);
  assert.equal(await cold.v.verifyToken('garbage'), null, 'but junk is still just a 401, without any fetch');
});
test('rotation + a failed refetch: the new kid answers 503 (not 401), failures are retried after 5 s, and the rotated key is not locked out for a minute', async () => {
  const logs = [], { v, tok, g, clock } = mk({ log: (o) => logs.push(o) });
  const NEW = makeEc();
  assert.ok(await ok(tok(), v)); assert.equal(g.calls, 1);
  clock.advance(61e3);
  g.fail = true;
  const rotated = () => tok({}, { pair: NEW, kid: 'iap-kid-2' });
  await assert.rejects(v.verifyToken(rotated()), (e) => e.status === 503 && !!e.headers['retry-after'], 'refetch failed: keys unavailable, not "not allowed"'); assert.equal(g.calls, 2);
  assert.ok(logs.some((l) => l.evt === 'iap.keys.error'));
  await assert.rejects(v.verifyToken(rotated()), (e) => e.status === 503); assert.equal(g.calls, 2, 'failures are throttled to one fetch per 5 s');
  assert.ok(await ok(tok(), v), 'a token under a key we already have still works during the outage');
  g.fail = false; g.keys = [jwkOfEc(GOOD, 'iap-kid-1'), jwkOfEc(NEW, 'iap-kid-2')];
  clock.advance(6e3);
  assert.ok(await ok(rotated(), v), 'the rotated key is picked up 6 s later, not after a 60 s lock-out'); assert.equal(g.calls, 3);
  // a SUCCESSFUL fetch that still lacks the kid is a plain 401, throttled to one refetch a minute
  const junk = tok({}, { pair: EVIL, kid: 'iap-kid-9' });
  clock.advance(61e3);
  assert.equal(await ok(junk, v), null); assert.equal(g.calls, 4);
  for (let i = 0; i < 5; i++) assert.equal(await ok(junk, v), null);
  assert.equal(g.calls, 4);
});
test('concurrent first requests share one key fetch', async () => {
  const { v, tok, g } = mk();
  const all = await Promise.all(Array.from({ length: 8 }, () => v.verifyToken(tok())));
  assert.ok(all.every(Boolean)); assert.equal(g.calls, 1);
});

// ---------------------------------------------------------------- logging
test('logs: reasons only, never a token; one line per reason per minute; unsigned goog headers are logged once and never trusted', async () => {
  const logs = [], { v, tok, clock } = mk({ log: (o) => logs.push(o) });
  const good = tok();
  const bad = good.slice(0, -6) + 'AAAAAA';
  for (let i = 0; i < 5; i++) await v.verifyToken(bad);
  assert.equal(logs.filter((l) => l.reason === 'signature').length, 1);
  clock.advance(61e3); await v.verifyToken(bad);
  assert.equal(logs.filter((l) => l.reason === 'signature').length, 2);
  await v.verifyToken(tok({ aud: 'x' }));
  assert.ok(logs.some((l) => l.reason === 'aud'));
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes(good.split('.')[1]) && !blob.includes(bad.split('.')[2]), 'no token material in the logs');
  assert.equal(await v.identify({ headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:ada@example.com', 'x-goog-authenticated-user-id': 'accounts.google.com:1' } }), null, 'unsigned headers give no identity');
  assert.equal(await v.identify({ headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:ada@example.com' } }), null);
  assert.equal(logs.filter((l) => l.evt === 'iap.misconfigured').length, 1, 'logged once');
  assert.ok(!JSON.stringify(logs).includes('ada@example.com'), 'and without the forged value');
  assert.ok(await v.identify({ headers: { 'x-goog-iap-jwt-assertion': good, 'x-goog-authenticated-user-email': 'accounts.google.com:mallory@example.com' } }), 'a valid token wins, and the header is not consulted');
});
