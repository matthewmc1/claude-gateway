import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_ADMIN_TEXT, NOT_ALLOWED_TEXT, REFUSED_TEXT, csrfHeaders, gateKind, identityLine, iapFailureMessage, parseAuthMode, roleLine } from '../src/logic/iap.ts';
import { failureMessage } from '../src/logic/errors.ts';

test('auth mode: only the exact string "iap" switches it on (older backends say nothing)', () => {
  assert.equal(parseAuthMode('iap'), 'iap');
  for (const v of [undefined, null, '', 'session', 'IAP', 'oauth', 1, true]) assert.equal(parseAuthMode(v), 'session');
});
test('every write in iap mode carries x-app-csrf; reads and session mode do not', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.deepEqual(csrfHeaders('iap', m), { 'x-app-csrf': '1' }, m);
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.deepEqual(csrfHeaders('iap', m), {}, m);
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.deepEqual(csrfHeaders('session', m), {}, m);
});
test('iap failures: 401 = not let through by the company sign-in, 403 = not an admin (or refused as cross-site)', () => {
  assert.equal(iapFailureMessage(401), NOT_ALLOWED_TEXT); assert.match(NOT_ALLOWED_TEXT, /Reload the page/); assert.match(NOT_ALLOWED_TEXT, /ask an admin/);
  assert.equal(iapFailureMessage(403, 'only admins can do this'), NOT_ADMIN_TEXT); assert.match(NOT_ADMIN_TEXT, /not on the admin list/);
  assert.equal(iapFailureMessage(403), NOT_ADMIN_TEXT);
  assert.equal(iapFailureMessage(403, 'cross-site or non-browser request refused'), REFUSED_TEXT);
  assert.equal(iapFailureMessage(403, 'cross-origin request refused'), REFUSED_TEXT);
  for (const s of [200, 400, 404, 409, 429, 500, 502, 503]) assert.equal(iapFailureMessage(s), null, String(s));
});
test('failureMessage uses the iap sentences only in iap mode, and keeps outage handling', () => {
  assert.equal(failureMessage(401, 'PUT', '/api/org/budget', null, 'iap'), NOT_ALLOWED_TEXT);
  assert.equal(failureMessage(403, 'PUT', '/api/org/budget', null, 'iap', 'only admins can do this'), NOT_ADMIN_TEXT);
  assert.equal(failureMessage(401, 'PUT', '/api/org/budget', null), null);
  assert.equal(failureMessage(403, 'PUT', '/api/org/budget', null, 'session'), null);
  assert.match(failureMessage(503, 'GET', '/api/users', 3, 'iap')!, /unavailable/);
});
test('identity and role lines', () => {
  assert.equal(identityLine({ email: 'ada@example.com' }), 'Signed in as ada@example.com via your company sign-in');
  assert.match(roleLine(true), /^Admin/); assert.match(roleLine(false), /^Viewer: read-only/);
});
test('gateKind: password page, IAP notices, or nothing', () => {
  const h = (o: object) => ({ viewAccess: 'open', auth: 'session', identity: null, admin: null, ...o });
  assert.equal(gateKind(null, false), 'none');
  assert.equal(gateKind(null, true), 'iap-denied', 'IAP answered 401 to /api/health');
  assert.equal(gateKind(h({}), false), 'none');
  assert.equal(gateKind(h({ viewAccess: 'admin' }), false), 'session', 'private data, nobody signed in: the password page');
  assert.equal(gateKind(h({ viewAccess: 'admin', admin: { email: 'a@x.com' } }), false), 'none');
  assert.equal(gateKind(h({ auth: 'iap', identity: { admin: false } }), false), 'none', 'a viewer sees open data without any form');
  assert.equal(gateKind(h({ auth: 'iap', viewAccess: 'admin', identity: { admin: false } }), false), 'iap-not-admin', 'never the password form behind IAP');
  assert.equal(gateKind(h({ auth: 'iap', viewAccess: 'admin', identity: { admin: true } }), false), 'none');
  assert.equal(gateKind(h({ auth: 'iap', viewAccess: 'admin', identity: null }), false), 'iap-not-admin');
});
