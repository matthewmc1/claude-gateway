// L6: the enterprise edge on a laptop. The REAL gateway binary behind an https "internal load balancer" emulator
// (https://gateway.localhost:<port>, throwaway CA) and the REAL budget app in iap mode behind an "IAP" emulator (http://app.localhost:<port>),
// with a local IdP. Everything here is an EMULATION of Google's edge: it proves our wiring (one origin, JWT verification, CSRF defence, TLS and
// trust, public_url vs Host), not Google's behaviour. Real IAP, the real ILB and real certificates stay unverified until deployed.
// Browser parts drive a real headless Chrome; they skip (loudly) when no Chrome is installed or app/dist is not built.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { E } from './lib/env.mjs';
import { ROOT } from './lib/config.mjs';
import { sleep } from './lib/gw.mjs';
import { startIapEmulator, BAD_KINDS } from '../../scripts/edge/iap-emulator.mjs';
import { startIlbEmulator } from '../../scripts/edge/ilb-emulator.mjs';
import {
  EP, APP_ORIGIN, GW_URL, ADMIN, VIEWER, OUTSIDER, req, form, verifyIap, startEcho, makeCerts, bootEdge, edgeDeviceLogin, findChrome, launchChrome, startEvilSite,
} from './lib/edge.mjs';

const tmp = fs.mkdtempSync(path.join(E.tmp, 'l6-'));
const AUD = '/projects/1234567890/locations/local/services/claude-budget-app';
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));

// ---------------------------------------------------------------- the emulators on their own
describe('L6 certificates, IAP emulator and ILB emulator in isolation', () => {
  let certs, echoI, iap, echoL, ilb, ilbDeny;
  before(async () => {
    certs = makeCerts(path.join(tmp, 'iso-certs'));
    echoI = await startEcho(EP.echoIap);
    iap = await startIapEmulator({ port: EP.iapSelf, upstream: `http://127.0.0.1:${EP.echoIap}`, audience: AUD, users: [ADMIN, VIEWER], quiet: true });
    echoL = await startEcho(EP.echoIlb);
    ilb = await startIlbEmulator({ port: EP.ilbSelf, upstream: `http://127.0.0.1:${EP.echoIlb}`, certDir: certs.dir, quiet: true });
    ilbDeny = await startIlbEmulator({ port: EP.ilbDeny, upstream: `http://127.0.0.1:${EP.echoIlb}`, certDir: certs.dir, allowCidrs: ['10.0.0.0/8', '::1/128'], quiet: true });
  });
  after(async () => { for (const x of [ilbDeny, ilb, echoL, iap, echoI]) await x?.close(); });
  const IAP = `http://app.localhost:${EP.iapSelf}`;
  const login = async (email) => (await req(IAP + '/_iap/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: IAP }, body: form({ email, next: '/x' }) }));

  test('make-certs.sh: CA + leaf, SAN gateway.localhost/localhost/127.0.0.1, short enough for browsers, private keys 0600, idempotent', () => {
    const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(certs.dir, 'gateway.pem')));
    const ca = new crypto.X509Certificate(certs.ca);
    assert.ok(leaf.verify(ca.publicKey) && leaf.issuer === ca.subject);
    assert.ok(ca.ca && !leaf.ca, 'only the CA may sign');
    for (const n of ['gateway.localhost', 'localhost']) assert.ok(leaf.checkHost(n), n);
    assert.ok(leaf.checkIP('127.0.0.1') && leaf.checkIP('::1'));
    assert.equal(leaf.checkHost('other.localhost'), undefined);
    const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400e3;
    assert.ok(days <= 398 && days > 300, `leaf lives ${days} days`);
    for (const f of ['ca.key', 'gateway.key']) assert.equal(fs.statSync(path.join(certs.dir, f)).mode & 0o777, 0o600, f);
    const before = fs.readFileSync(path.join(certs.dir, 'gateway.pem'), 'utf8');
    assert.match(execFileSync('bash', [path.join(ROOT, 'scripts/edge/make-certs.sh'), certs.dir], { encoding: 'utf8' }), /certs ok/);
    assert.equal(fs.readFileSync(path.join(certs.dir, 'gateway.pem'), 'utf8'), before, 'a second run keeps the certificate');
    assert.equal(execFileSync('git', ['check-ignore', 'data/edge/ca.pem'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'data/edge/ca.pem', 'generated certificates are gitignored');
  });

  test('IAP: signed out gets a 302 to the sign-in page, JSON callers a 401, and nothing reaches the app', async () => {
    const nav = await req(IAP + '/some/page?x=1', { headers: { accept: 'text/html' } });
    assert.equal(nav.status, 302); assert.equal(nav.headers.location, '/_iap/signin?next=' + encodeURIComponent('/some/page?x=1'));
    const xhr = await req(IAP + '/api/users', { headers: { accept: 'application/json' } });
    assert.equal(xhr.status, 401); assert.equal(xhr.json.error, 'sign-in required');
    assert.equal((await req(IAP + '/api/x', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(echoI.seen.length, 0, 'unauthenticated requests are not proxied');
    const page = await req(IAP + '/_iap/signin');
    assert.equal(page.status, 200); assert.ok(page.text.includes(ADMIN) && page.text.includes(VIEWER));
  });

  test('IAP: only listed people sign in; the cookie is HttpOnly and tamper-proof; open redirects are refused', async () => {
    const no = await login(OUTSIDER);
    assert.equal(no.status, 403); assert.deepEqual(no.cookies, []);
    assert.equal((await req(IAP + '/_iap/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.localhost' }, body: form({ email: ADMIN }) })).status, 403, 'cross-site sign-in post');
    const ok = await login(ADMIN);
    assert.equal(ok.status, 302); assert.equal(ok.headers.location, '/x');
    assert.match(ok.headers['set-cookie'][0], /HttpOnly/); assert.match(ok.headers['set-cookie'][0], /SameSite=Lax/);
    const [name, val] = ok.cookies[0].split('=');
    const forged = `${name}=${Buffer.from('root@example.com').toString('base64url')}.${val.split('.')[1]}`;
    assert.equal((await req(IAP + '/', { headers: { cookie: forged, accept: 'text/html' } })).status, 302, 'a cookie for another email with the old signature is not a session');
    const evil = await req(IAP + '/_iap/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: IAP }, body: form({ email: ADMIN, next: '//evil.example/x' }) });
    assert.equal(evil.headers.location, '/', 'next must be a local path');
  });

  test('IAP: forwards with Host preserved, a verifiable ES256 JWT (iss, aud, ~10 min, kid, email/sub/hd), and strips client x-goog-* headers', async () => {
    const jwks = (await req(IAP + '/.well-known/iap-keys.json')).json;
    assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    assert.deepEqual([jwks.keys[0].kty, jwks.keys[0].crv, jwks.keys[0].alg], ['EC', 'P-256', 'ES256']);
    const cookie = (await login(ADMIN)).cookies.join('; ');
    // a valid-looking token for somebody else, an email header and a made-up x-goog header, all supplied by the client
    const stolen = iap.makeJwt('ceo@example.com');
    const r = await req(IAP + '/api/q?a=1&b=2', { method: 'POST', headers: { cookie: cookie + '; theirs=1', 'content-type': 'application/json', 'x-goog-iap-jwt-assertion': stolen, 'x-goog-authenticated-user-email': 'accounts.google.com:ceo@example.com', 'x-goog-foo': 'bar', 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' }, body: '{"hello":"world"}' });
    assert.equal(r.status, 200);
    const seen = r.json;
    assert.equal(seen.headers.host, `app.localhost:${EP.iapSelf}`, 'Host is preserved, not rewritten to the upstream');
    assert.equal(seen.url, '/api/q?a=1&b=2'); assert.equal(seen.body, '{"hello":"world"}');
    const claims = verifyIap(seen.headers['x-goog-iap-jwt-assertion'], { jwks, aud: AUD });
    assert.equal(claims.email, ADMIN, 'the signed identity is the signed-in person, not what the client sent');
    assert.match(claims.sub, /^accounts\.google\.com:\d+$/); assert.equal(claims.hd, 'example.com');
    assert.ok(claims.exp - claims.iat === 600, 'ten minutes'); assert.equal(decodeJwt(seen.headers['x-goog-iap-jwt-assertion']).iss, 'https://cloud.google.com/iap');
    assert.equal(JSON.parse(Buffer.from(seen.headers['x-goog-iap-jwt-assertion'].split('.')[0], 'base64url')).kid, jwks.keys[0].kid);
    assert.equal(seen.headers['x-goog-authenticated-user-email'], 'accounts.google.com:' + ADMIN);
    assert.match(seen.headers['x-goog-authenticated-user-id'], /^accounts\.google\.com:\d+$/);
    assert.equal(seen.headers['x-goog-foo'], undefined, 'unknown x-goog-* headers are stripped');
    assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1', 'client-supplied forwarding headers are replaced');
    assert.equal(seen.headers['x-forwarded-proto'], 'http');
    assert.equal(seen.headers.cookie, 'theirs=1', 'the emulator session cookie never reaches the app');
    assert.throws(() => verifyIap(stolen, { jwks, aud: AUD }) && verifyIap(stolen, { jwks, aud: AUD + 'x' }), /aud/);
    assert.ok(Math.abs(Date.now() / 1000 - claims.iat) < 10);
  });

  test('IAP: ?secure_token_test=<kind> sends a token a correct verifier rejects (and is not forwarded to the app)', async () => {
    const jwks = (await req(IAP + '/.well-known/iap-keys.json')).json;
    const cookie = (await login(VIEWER)).cookies.join('; ');
    const why = { 'bad-signature': 'signature', expired: 'expired', 'wrong-aud': 'aud', 'wrong-iss': 'iss', 'wrong-alg': 'alg', 'unknown-kid': 'kid', 'too-long': 'lifetime', 'no-email': 'email', garbage: 'undecodable|JWT' };
    assert.deepEqual(Object.keys(why).sort(), BAD_KINDS.filter((k) => k !== 'none').sort(), 'every kind is covered');
    for (const kind of Object.keys(why)) {
      const r = await req(IAP + `/p?secure_token_test=${kind}&keep=1`, { headers: { cookie } });
      assert.equal(r.status, 200, kind);
      assert.equal(r.json.url, '/p?keep=1', 'the test parameter is consumed by the proxy');
      assert.throws(() => verifyIap(r.json.headers['x-goog-iap-jwt-assertion'], { jwks, aud: AUD }), new RegExp(why[kind]), kind);
    }
    const bare = await req(IAP + '/p?secure_token_test', { headers: { cookie } });
    assert.throws(() => verifyIap(bare.json.headers['x-goog-iap-jwt-assertion'], { jwks, aud: AUD }), /signature/, 'no value means a bad signature');
    const none = await req(IAP + '/p?secure_token_test=none', { headers: { cookie } });
    assert.equal(none.json.headers['x-goog-iap-jwt-assertion'], undefined); assert.equal(none.json.headers['x-goog-authenticated-user-email'], undefined);
    const good = await req(IAP + '/p', { headers: { cookie } });
    assert.ok(verifyIap(good.json.headers['x-goog-iap-jwt-assertion'], { jwks, aud: AUD }), 'and without the parameter the token is fine');
  });

  test('ILB: https with the generated CA only; Host kept; X-Forwarded-For/-Proto like Google\'s LB; bodies stream through', async () => {
    const base = `https://gateway.localhost:${EP.ilbSelf}`;
    const r = await req(base + '/v1/x?y=1', { ca: certs.ca, method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, body: '{"a":[1,2,3]}' });
    assert.equal(r.status, 200);
    assert.equal(r.json.headers.host, `gateway.localhost:${EP.ilbSelf}`); assert.equal(r.json.url, '/v1/x?y=1'); assert.equal(r.json.body, '{"a":[1,2,3]}');
    assert.equal(r.json.headers['x-forwarded-for'], '203.0.113.9,127.0.0.1,127.0.0.1'); assert.equal(r.json.headers['x-forwarded-proto'], 'https');
    const bare = await req(base + '/', { ca: certs.ca });
    assert.equal(bare.json.headers['x-forwarded-for'], '127.0.0.1,127.0.0.1');
    await assert.rejects(req(base + '/'), (e) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(e.code), 'without the CA the certificate is not trusted');
    await assert.rejects(req(`http://gateway.localhost:${EP.ilbSelf}/`), 'plain http is not served');
    await assert.rejects(req(`https://other.localhost:${EP.ilbSelf}/`, { ca: certs.ca }), (e) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID', 'a name outside the SAN is refused');
    for (const h of ['localhost', '127.0.0.1']) assert.equal((await req(`https://${h}:${EP.ilbSelf}/`, { ca: certs.ca })).status, 200, h);
  });

  test('ILB: the optional allow-list refuses clients outside the ranges', async () => {
    const r = await req(`https://gateway.localhost:${EP.ilbDeny}/`, { ca: certs.ca });
    assert.equal(r.status, 403);
    assert.ok(!echoL.seen.some((s) => s.headers.host === `gateway.localhost:${EP.ilbDeny}`), 'nothing was forwarded');
  });
});

// ---------------------------------------------------------------- the whole edge, with the real gateway and the real app
describe('L6 the whole edge: IAP emulator -> app (iap mode) -> ILB emulator -> real gateway', () => {
  let edge, evil, alice, personal0;
  const jwks = () => edge.iap.jwks;
  const gwLimits = async () => (await edge.gwAdmin('GET', '?limit=1000')).json.data;
  const gwAudit = async () => (await edge.gwAdmin('GET', '/audit?limit=500')).json.data;
  const userLimit = async (sub, period = 'weekly') => (await gwLimits()).find((l) => l.scope.type === 'user' && l.scope.user_id === sub && l.period === period) || null;

  before(async () => {
    edge = await bootEdge({ dataDir: path.join(tmp, 'edge') });
    evil = await startEvilSite();
    // one real person, signed in through the real device flow over https, who makes a request so the gateway knows them
    const login = await edgeDeviceLogin(edge, 'alice@example.com');
    const sub = decodeJwt(login.token).sub;
    const m = await req(GW_URL + '/v1/messages', { ca: edge.ca, method: 'POST', headers: { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' }, body: { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] } });
    assert.equal(m.status, 200, 'inference through https load balancer -> gateway (canned reply): ' + m.text.slice(0, 200));
    for (let i = 0; i < 80; i++) { const r = await edge.gwAdmin('GET', '/effective?period%5B%5D=weekly&limit=1000'); if ((r.json?.data || []).some((x) => x.scope.user_id === sub)) break; await sleep(150); }
    alice = { ...login, sub };
    personal0 = await userLimit(sub);
  });
  after(async () => { await evil?.close(); await edge?.close(); });

  describe('the identity perimeter (IAP) and the app behind it', () => {
    test('signed out: 302 to sign-in, 401 for JSON; the app port itself refuses requests that did not come through IAP', async () => {
      assert.equal((await req(APP_ORIGIN + '/', { headers: { accept: 'text/html' } })).status, 302);
      assert.equal((await req(APP_ORIGIN + '/api/users', { headers: { accept: 'application/json' } })).status, 401);
      const d = (p, headers = {}) => edge.direct('GET', p, { headers });
      assert.equal((await d('/healthz')).status, 200, 'probes need no JWT');
      for (const [name, h] of [
        ['no credentials', {}],
        ['the unsigned x-goog headers alone (what a client could forge)', { 'x-goog-authenticated-user-email': 'accounts.google.com:' + ADMIN, 'x-goog-authenticated-user-id': 'accounts.google.com:1' }],
        ['a token signed by a key IAP never published', { 'x-goog-iap-jwt-assertion': edge.iap.makeJwt(ADMIN, 'bad-signature') }],
        ['a token for another audience', { 'x-goog-iap-jwt-assertion': edge.iap.makeJwt(ADMIN, 'wrong-aud') }],
        ['an expired token', { 'x-goog-iap-jwt-assertion': edge.iap.makeJwt(ADMIN, 'expired') }],
        ['an HS256 token keyed with the public key', { 'x-goog-iap-jwt-assertion': edge.iap.makeJwt(ADMIN, 'wrong-alg') }],
      ]) {
        const r = await d('/api/users', h); assert.equal(r.status, 401, name);
        assert.equal((await d('/api/health', h)).status, 401, name + ' (health too)');
      }
      assert.match(edge.appLog(), /iap\.misconfigured/, 'the app notes that unsigned headers arrived without a JWT');
    });

    test('viewer vs admin: both read; only the admin is an admin; the identity comes from the signed token', async () => {
      const ada = await edge.person(ADMIN), bob = await edge.person(VIEWER);
      const ha = await ada.call('GET', '/api/health'), hb = await bob.call('GET', '/api/health');
      assert.equal(ha.status, 200); assert.equal(ha.json.gateway, true, 'the app reaches the gateway over https with GATEWAY_CA_PEM through the load-balancer emulator');
      assert.equal(ha.json.admin.email, ADMIN); assert.equal(hb.json.admin, null);
      assert.equal((await bob.call('GET', '/api/users')).status, 200);
      assert.equal((await bob.call('POST', '/api/login', { body: { email: ADMIN, password: 'whatever-12345' } })).status, 410, 'there is no password sign-in behind IAP');
      // bob sends ada's valid-looking token and header: the emulator replaces them with bob's own
      const spoof = await bob.call('GET', '/api/health', { headers: { 'x-goog-iap-jwt-assertion': edge.iap.makeJwt(ADMIN), 'x-goog-authenticated-user-email': 'accounts.google.com:' + ADMIN } });
      assert.equal(spoof.json.admin, null, 'a viewer cannot become an admin by sending someone else\'s token');
      const w = await bob.call('PUT', `/api/users/${alice.sub}/budget`, { body: { period: 'weekly', action: 'set', usd: 99 } });
      assert.equal(w.status, 403, 'a viewer\'s write is refused even with every CSRF header');
      assert.equal((await userLimit(alice.sub))?.amount ?? null, personal0?.amount ?? null);
    });

    test('an admin cap change succeeds through the whole chain and shows in the gateway\'s own admin API and audit', async () => {
      const ada = await edge.person(ADMIN);
      const before = (await gwAudit()).length;
      const r = await ada.call('PUT', `/api/users/${encodeURIComponent(alice.sub)}/budget`, { body: { period: 'weekly', action: 'set', usd: 12.34 } });
      assert.equal(r.status, 200, r.text);
      assert.equal((await userLimit(alice.sub)).amount, '1234', 'visible via https://gateway.localhost, with the generated CA');
      const ev = (await gwAudit()).find((e) => e.action === 'spend_limit.upsert' && e.after?.amount === '1234');
      assert.equal(ev.actor, 'admin-key:' + ADMIN, 'the write used the admin\'s own gateway key');
      const u = await ada.call('GET', `/api/users/${encodeURIComponent(alice.sub)}`);
      assert.equal(u.status, 200); assert.equal(u.json.user.budgets.weekly.capCents, 1234);
      assert.ok((await gwAudit()).length > before);
    });

    test('writes are refused without x-app-csrf, with a foreign or mismatched Origin, cross-site fetch metadata, a viewer, or any invalid IAP JWT', async () => {
      const ada = await edge.person(ADMIN);
      const path = `/api/users/${encodeURIComponent(alice.sub)}/budget`, body = { period: 'weekly', action: 'set', usd: 777 };
      const auditBefore = (await gwAudit()).length;
      const attempts = [   // [name, headers to set (undefined = leave out), query, expected status]
        ['no x-app-csrf', { 'x-app-csrf': undefined }, '', 403],
        ['x-app-csrf with another value', { 'x-app-csrf': '0' }, '', 403],
        ['foreign Origin', { origin: evil.origin }, '', 403],
        ['Origin on the app host but another port (what a rewritten Host would look like)', { origin: `http://app.localhost:${EP.appInternal}` }, '', 403],
        ['Origin of the loopback address (not the IAP host)', { origin: `http://127.0.0.1:${EP.app}` }, '', 403],
        ['Origin null', { origin: 'null' }, '', 403],
        ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }, '', 403],
        ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }, '', 403],
        ['neither Origin nor Sec-Fetch-Site (the custom header alone is not a same-origin proof)', { origin: undefined, 'sec-fetch-site': undefined }, '', 403],
        ['Sec-Fetch-Site none and no Origin (a typed URL cannot be a write)', { origin: undefined, 'sec-fetch-site': 'none' }, '', 403],
        ...['', ...BAD_KINDS].map((k) => [`secure_token_test=${k || '(bare)'}`, {}, `?secure_token_test=${k}`, 401]),
      ];
      for (const [name, set, query, want] of attempts) {
        const headers = { cookie: ada.cookie, accept: 'application/json', 'content-type': 'application/json', origin: APP_ORIGIN, 'x-app-csrf': '1', 'sec-fetch-site': 'same-origin', ...set };
        for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
        const r = await req(APP_ORIGIN + path + query, { method: 'PUT', headers, body });
        assert.equal(r.status, want, `${name}: ${r.text.slice(0, 100)}`);
      }
      // a cross-site or same-site GET is refused too (Fetch Metadata on every /api request), and answers carry Cross-Origin-Resource-Policy
      for (const sfs of ['cross-site', 'same-site']) assert.equal((await ada.call('GET', '/api/users', { headers: { 'sec-fetch-site': sfs } })).status, 403, 'read with Sec-Fetch-Site ' + sfs);
      assert.equal((await ada.call('GET', '/api/users')).headers['cross-origin-resource-policy'], 'same-origin');
      // GET with a bad token is refused too: in iap mode the JWT is the perimeter, even for open-view data
      for (const k of ['bad-signature', 'expired', 'wrong-aud', 'none']) assert.equal((await ada.call('GET', `/api/users?secure_token_test=${k}`)).status, 401, 'read with ' + k);
      assert.equal((await userLimit(alice.sub)).amount, '1234', 'nothing changed');
      assert.equal((await gwAudit()).length, auditBefore, 'the gateway saw none of these');
    });

    test('Host and Origin agree end to end: the browser origin, the Host the app sees and the allow-list are the same http://app.localhost:<port>', async () => {
      const ada = await edge.person(ADMIN);
      // the app only accepts a write whose Origin equals http://<Host it received>: this succeeds, so the proxy preserved Host
      assert.equal((await ada.call('PUT', '/api/org/budget', { body: { period: 'monthly', action: 'set', usd: 321 } })).status, 200);
      assert.equal((await gwLimits()).find((l) => l.scope.type === 'organization' && l.period === 'monthly').amount, '32100');
      // and it does not accept the same request when the Host is something else (DNS-rebinding guard)
      const rebind = await req(APP_ORIGIN + '/api/health', { headers: { cookie: ada.cookie, host: `evil.example:${EP.app}` } });
      assert.ok([400, 403].includes(rebind.status) || rebind.status === 302, 'a foreign Host never reaches the app: ' + rebind.status);
      const log = edge.appLog(); assert.ok(!/GATEWAY|writeKey|x-goog-iap-jwt-assertion|eyJ/.test(log), 'no tokens or keys in the app log');
    });
  });

  describe('the gateway behind the internal load balancer emulator', () => {
    test('reachable only over https://gateway.localhost with the generated CA; not over http, not with another name, not without the CA', async () => {
      assert.equal((await req(GW_URL + '/readyz', { ca: edge.ca })).status, 200);
      await assert.rejects(req(GW_URL + '/readyz'), (e) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(e.code));
      await assert.rejects(req(`http://gateway.localhost:${EP.gateway}/readyz`));
      await assert.rejects(req(`https://app.localhost:${EP.gateway}/readyz`, { ca: edge.ca }), (e) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
      const root = await req(GW_URL + '/', { ca: edge.ca }); assert.ok(root.text.includes('Running at ' + GW_URL), 'the gateway believes its public URL is the https balancer URL');
      assert.equal(await new Promise((ok) => { const s = net.connect(EP.gwInternal, '127.0.0.1', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); }), true, 'the plain-http listener is loopback-only behind the balancer');
    });

    test('device sign-in: /device is served under the same https origin and the OIDC redirect_uri host equals the public_url host', async () => {
      const d = alice.device;
      assert.equal(new URL(d.verification_uri).origin, GW_URL, 'the verification page is on the public https origin');
      const page = await req(d.verification_uri_complete, { ca: edge.ca }); assert.equal(page.status, 200, '/device page'); assert.match(page.text, /code/i);
      assert.equal(alice.redirectUri, GW_URL + '/oauth/callback');
      assert.equal(new URL(alice.redirectUri).host, new URL(GW_URL).host, 'redirect_uri host == public_url host == the Host the browser used');
      const seen = edge.idp.seen.at(-1); assert.equal(seen.redirect_uri, alice.redirectUri);
      assert.equal(alice.callbackStatus < 400, true, 'callback accepted on the https origin');
      assert.equal(decodeJwt(alice.token).iss, GW_URL, 'session tokens are issued for the public https URL');
    });

    test('the load balancer\'s allow-list is honoured and X-Forwarded-For reaches the gateway chain (trusted_proxies) without breaking requests', async () => {
      const r = await req(GW_URL + '/readyz', { ca: edge.ca, headers: { 'x-forwarded-for': '198.51.100.7' } });
      assert.equal(r.status, 200);
      const m = await req(GW_URL + '/v1/messages', { ca: edge.ca, method: 'POST', headers: { authorization: 'Bearer ' + alice.token, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' }, body: { model: 'claude-sonnet-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] } });
      assert.equal(m.status, 200);
    });
  });

  describe('a real headless Chrome', () => {
    const chromeBin = findChrome(), dist = fs.existsSync(path.join(ROOT, 'app', 'dist', 'index.html'));
    let chrome;
    before(async () => { if (chromeBin) chrome = await launchChrome({ tmp, spki: edge.certs.spki }); });
    after(async () => { await chrome?.close(); });
    const need = (t) => { if (!chromeBin) { t.skip('no Chrome found (set CHROME=...)'); return false; } if (!dist) { t.skip('app/dist is not built (cd app && npx expo export -p web)'); return false; } return true; };

    test('sign in through the emulator, land on the app at the same origin with no CORS/CSRF/console errors, admin recognised', async (t) => {
      if (!need(t)) return;
      const page = await chrome.newPage();
      try {
        await page.goto(APP_ORIGIN + '/');
        assert.equal(new URL(await page.url()).pathname, '/_iap/signin', 'redirected to the sign-in page, same origin');
        assert.equal(await page.eval('location.origin'), APP_ORIGIN);
        await page.eval(`document.querySelector('button[value="${ADMIN}"]').click()`);
        await page.until(`location.pathname === '/' && document.body.innerText.trim().length > 20 && !!document.querySelector('#root')`);
        assert.equal(await page.eval('location.origin'), APP_ORIGIN, 'the app is served from the origin the browser asked for');
        await sleep(1500);   // let the app finish its own API calls
        const api = page.log.requests.filter((r) => r.url.startsWith(APP_ORIGIN + '/api/'));
        assert.ok(api.length >= 1, 'the app talked to its own origin: ' + JSON.stringify(page.log.requests.map((r) => r.url).slice(0, 8)));
        assert.deepEqual(page.log.failed, [], 'no failed network requests (CORS failures show up here)');
        assert.deepEqual(page.log.http, [], 'no 4xx/5xx answers while loading the app');
        assert.deepEqual(page.log.console.filter((l) => /CORS|CSRF|blocked|refused|Failed to fetch|cross-origin/i.test(l)), [], 'no CORS/CSRF complaints in the console');
        const health = await page.eval(`fetch('/api/health', { headers: { accept: 'application/json' } }).then((r) => r.json())`);
        assert.equal(health.admin.email, ADMIN); assert.equal(health.gateway, true);
        assert.equal(await page.eval('document.cookie'), '', 'the IAP session cookie is HttpOnly');
        // same-origin write from the page, the way the app's own code makes it
        const put = (headers) => page.eval(`fetch('/api/org/budget', { method: 'PUT', headers: ${JSON.stringify({ 'content-type': 'application/json', ...headers })}, body: JSON.stringify({ period: 'monthly', action: 'set', usd: 456 }) }).then(async (r) => [r.status, await r.text()])`);
        assert.equal((await put({}))[0], 403, 'the browser refuses nothing, the app does: no x-app-csrf');
        assert.equal((await put({ 'x-app-csrf': '1' }))[0], 200, 'with x-app-csrf the same-origin write goes through');
        assert.equal((await gwLimits()).find((l) => l.scope.type === 'organization' && l.period === 'monthly').amount, '45600');
      } finally { page.close(); }
    });

    test('a foreign origin in the same browser cannot write: CORS blocks it and nothing reaches the gateway', async (t) => {
      if (!need(t)) return;
      const page = await chrome.newPage();
      try {
        await page.goto(evil.origin + '/');
        assert.equal(await page.eval('location.origin'), evil.origin);
        const before = JSON.stringify((await gwLimits()).map((l) => [l.id, l.amount]));
        const attempt = (init) => page.eval(`fetch(${JSON.stringify(APP_ORIGIN + '/api/org/budget')}, ${JSON.stringify(init)}).then((r) => 'status ' + r.status, (e) => 'blocked: ' + e.message)`);
        const body = JSON.stringify({ period: 'monthly', action: 'set', usd: 1 });
        const results = [
          await attempt({ method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'x-app-csrf': '1' }, body }),   // preflighted
          await attempt({ method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body }),            // simple request
        ];
        assert.match(results[0], /blocked/, 'a cross-origin request with the custom header needs a preflight that is never granted');
        assert.ok(!/status 2/.test(results[1]), 'the opaque simple request cannot succeed either: ' + results[1]);
        assert.equal(JSON.stringify((await gwLimits()).map((l) => [l.id, l.amount])), before, 'the gateway saw no change');
      } finally { page.close(); }
    });

    test('the gateway\'s /device page loads over https under the same origin in the browser (generated leaf accepted)', async (t) => {
      if (!chromeBin) return t.skip('no Chrome found (set CHROME=...)');
      const page = await chrome.newPage();
      try {
        await page.goto(GW_URL + '/device');
        assert.equal(await page.eval('location.origin'), GW_URL); assert.equal(await page.eval('window.isSecureContext'), true);
        assert.equal(await page.eval(`performance.getEntriesByType('navigation')[0].responseStatus`), 200);
        assert.match(await page.eval('document.body.innerText'), /code/i);
      } finally { page.close(); }
    });
  });
});
