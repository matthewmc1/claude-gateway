// Fixtures for the scheduler-token tests: locally generated RSA keys, a fake Google JWKS endpoint, and a JWT signer. Not a test file.
import crypto from 'node:crypto';
import { SCHEDULER_AUDIENCE, SCHEDULER_SA } from './api-helpers.mjs';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export const makeKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const GOOD = makeKey(), EVIL = makeKey();
export const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

// A fetch that serves Google's JWKS. `calls` counts requests; `keys` can be swapped to simulate rotation; `fail` makes it error.
export function fakeGoogle(keys = [jwkOf(GOOD, 'good-kid')]) {
  const g = { keys, calls: 0, fail: false, urls: [] };
  g.fetch = async (url) => {
    g.calls++; g.urls.push(String(url));
    if (g.fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ keys: g.keys }) };
  };
  return g;
}

// Signs claims with `pair`. `claims` overrides the defaults; set a key to undefined to drop it.
export function signJwt(clock, claims = {}, { pair = GOOD, kid = 'good-kid', alg = 'RS256', sig } = {}) {
  const nowS = Math.floor(clock.t / 1000);
  const c = { iss: 'https://accounts.google.com', email: SCHEDULER_SA, email_verified: true, aud: SCHEDULER_AUDIENCE, iat: nowS - 5, exp: nowS + 3600, ...claims };
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  const head = { alg, typ: 'JWT', ...(kid === null ? {} : { kid }) };
  const body = b64(head) + '.' + b64(c);
  const signature = sig ?? (alg === 'RS256' ? crypto.sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url') : '');
  return body + '.' + signature;
}
