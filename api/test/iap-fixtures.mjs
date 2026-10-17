// Fixtures for the IAP tests: locally generated P-256 keys, a fake IAP key endpoint, and an IAP JWT signer. Not a test file.
import crypto from 'node:crypto';
import { SECRETS, testCfg } from './api-helpers.mjs';

export const IAP_AUD = '/projects/123456789012/locations/europe-west2/services/claude-budget-app';
export const IAP_LB_AUD = '/projects/123456789012/global/backendServices/4567890123';
export const IAP_ISS = 'https://cloud.google.com/iap';
export const ADA = 'ada@example.com';          // an admin (listed in APP_ADMINS, any letter case)
export const VIEWER = 'eve@example.com';       // passes IAP, not an admin

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export const makeEc = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const GOOD = makeEc(), EVIL = makeEc();
export const jwkOfEc = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' });

// Serves Google's IAP key set. `calls` counts requests; `keys` can be swapped (rotation); `fail` errors; `body` overrides the payload.
export function fakeIapKeys(keys = [jwkOfEc(GOOD, 'iap-kid-1')]) {
  const g = { keys, calls: 0, fail: false, body: null, opts: [], urls: [] };
  g.fetch = async (url, opts) => {
    g.calls++; g.urls.push(String(url)); g.opts.push(opts);
    if (g.fail) throw new Error('network down');
    const text = g.body ?? JSON.stringify({ keys: g.keys });
    return { ok: true, status: 200, headers: new Map(), text: async () => text };
  };
  return g;
}

export const nowS = (clock) => Math.floor(clock.t / 1000);
// Claims IAP would send. Set a key to undefined in `claims` to drop it.
export const iapClaims = (clock, claims = {}) => {
  const c = { iss: IAP_ISS, aud: IAP_AUD, sub: 'accounts.google.com:1234567890', email: ADA, iat: nowS(clock) - 5, exp: nowS(clock) + 595, hd: 'example.com', ...claims };
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  return c;
};

// Signs ES256 the JWS way (raw r||s). `sig` replaces the signature, `head` the header, `alg` only relabels it.
export function signIap(clock, claims = {}, { pair = GOOD, kid = 'iap-kid-1', alg = 'ES256', sig, head } = {}) {
  const h = head ?? { alg, typ: 'JWT', ...(kid === null ? {} : { kid }) };
  const body = b64(h) + '.' + b64(iapClaims(clock, claims));
  const signature = sig ?? crypto.sign('sha256', Buffer.from(body), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return body + '.' + signature;
}

export const IAP_ENV = (extra = {}) => ({
  APP_AUTH_MODE: 'iap', IAP_AUDIENCE: IAP_AUD,
  APP_ADMINS: JSON.stringify([
    { email: 'Ada@Example.com', name: 'Ada Admin', writeKey: SECRETS.adaKey },                      // no password: not needed in iap mode
    { email: 'bob@example.com', password: SECRETS.bobPw, writeKey: SECRETS.bobKey },
  ]),
  ...extra,
});
export const iapCfg = (extra = {}, patch = {}) => testCfg(IAP_ENV(extra), patch);
