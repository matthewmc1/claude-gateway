import test from 'node:test';
import assert from 'node:assert/strict';
import { failureMessage, retryAfterSeconds, UNAVAILABLE_TEXT, UNAVAILABLE_WRITE_TEXT } from '../src/logic/errors.ts';

test('Retry-After parsing', () => {
  assert.equal(retryAfterSeconds('30'), 30); assert.equal(retryAfterSeconds('1.2'), 2);
  for (const bad of [null, undefined, '', '0', '-5', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT']) assert.equal(retryAfterSeconds(bad as any), null, String(bad));
});
test('login 429 says how long to wait', () => {
  assert.equal(failureMessage(429, 'POST', '/api/login', 42), 'Too many attempts, try again in 42 s.');
  assert.match(failureMessage(429, 'POST', '/api/login', null)!, /Too many attempts/);
  assert.equal(failureMessage(429, 'POST', '/api/overrides', 5), null);        // other 429s keep the server's own text
});
test('gateway outages read as outages, reads retry, writes say the change may not have landed', () => {
  for (const s of [502, 503, 504]) { assert.equal(failureMessage(s, 'GET', '/api/users', 3), UNAVAILABLE_TEXT); assert.equal(failureMessage(s, 'PUT', '/api/org/budget', 3), UNAVAILABLE_WRITE_TEXT); }
  assert.equal(failureMessage(500, 'GET', '/api/users', null), null); assert.equal(failureMessage(400, 'POST', '/api/overrides', null), null);
  assert.match(UNAVAILABLE_WRITE_TEXT, /may not have been applied/);
});
