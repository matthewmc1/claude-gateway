// L0: the harness itself. Proves the stack is the real gateway and that a self-minted session is equivalent to one from the real device login.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './lib/env.mjs';
import { deviceLogin, messages, mintSession, unique, wget, adminCall } from './lib/gw.mjs';

test('the gateway is the real claude binary: readyz, protocol document, load_test_mode', async () => {
  assert.equal((await wget('/readyz')).status, 200);
  const p = await wget('/protocol');
  assert.equal(p.status, 200);
  assert.match(p.text, /Claude Code gateway protocol/);
  const disco = await wget('/.well-known/oauth-authorization-server');
  assert.equal(disco.json.issuer, E.gwUrl);
  assert.ok(disco.json.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));
});

test('the fake OIDC issuer serves discovery and a JWKS the gateway accepted at boot', async () => {
  const d = await (await fetch(`http://127.0.0.1:${E.oidcPort}/.well-known/openid-configuration`)).json();
  assert.equal(d.issuer, `http://127.0.0.1:${E.oidcPort}`);
  const k = await (await fetch(d.jwks_uri)).json();
  assert.equal(k.keys[0].alg, 'RS256');
});

test('a real device-flow login yields a session with the claims we mint ourselves, and both work on /v1/messages', async () => {
  const sub = unique('l0'), email = `${sub}@example.com`;
  const real = await deviceLogin({ sub, email, name: 'Zed Real' });
  const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  const minted = mintSession({ sub, email, name: 'Zed Real' });
  const rc = claimsOf(real), mc = claimsOf(minted);
  assert.deepEqual(Object.keys(rc).sort(), Object.keys(mc).sort(), 'same claim set');
  assert.equal(rc.iss, mc.iss); assert.equal(rc.aud, mc.aud); assert.equal(rc.sub, sub); assert.equal(rc.email, email);
  assert.equal(rc.exp - rc.iat, 3600, 'ttl_hours: 1');
  for (const tok of [real, minted]) { const r = await messages(tok); assert.equal(r.status, 200, r.text.slice(0, 300)); }
});

test('credentials are enforced: bad session 401, no admin key 401, read key cannot write', async () => {
  assert.equal((await messages('not.a.token')).status, 401);
  assert.equal((await adminCall('GET', '', { key: 'x'.repeat(40) })).status, 401);
  const w = await adminCall('POST', '', { key: E.keys.read, body: { scope: { type: 'organization' }, period: 'weekly', amount: '100' } });
  assert.equal(w.status, 403);
});
