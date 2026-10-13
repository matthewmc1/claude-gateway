import test from 'node:test';
import assert from 'node:assert/strict';
import { matchModel, priceHint, tierInfo, usageShares } from '../src/logic/models.ts';

const models = [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }];
test('matchModel: exact, dated suffix, unknown', () => {
  assert.equal(matchModel('claude-opus-5-5', models), 'claude-opus-5-5');
  assert.equal(matchModel('claude-opus-5-5-20260101', models), 'claude-opus-5-5');
  assert.equal(matchModel('claude-opus-5-50', models), null);
  assert.equal(matchModel('(none)', models), null);
});
test('usage shares add up and unknown models are reported separately', () => {
  const r = usageShares(models, [{ model: 'claude-sonnet-5-5', requests: 60, ok: 58 }, { model: 'claude-opus-5-5-20260101', requests: 30, ok: 30 }, { model: '(none)', requests: 10, ok: 0 }]);
  assert.equal(r.total, 100);
  assert.equal(r.by.get('claude-sonnet-5-5')!.share, 0.6);
  assert.equal(r.by.get('claude-opus-5-5')!.requests, 30);
  assert.equal(r.by.get('claude-haiku-5-5')!.share, 0);
  assert.equal(r.other.length, 1);
  assert.equal(r.other[0].share, 0.1);
});
test('no traffic gives zero shares, no NaN', () => {
  const r = usageShares(models, []);
  assert.equal(r.total, 0);
  assert.equal(r.by.get('claude-sonnet-5-5')!.share, 0);
});
test('price hints only appear when the operator set prices', () => {
  assert.equal(priceHint(null), null);
  assert.equal(priceHint({ input: null, output: null, cacheRead: null, cacheWrite: null }), null);
  assert.equal(priceHint({ input: 3, output: 15, cacheRead: null, cacheWrite: null }), '$3 in · $15 out per 1M tokens');
  assert.equal(priceHint({ input: 0.8, output: null, cacheRead: 0.08, cacheWrite: null }), '$0.80 in · $0.08 cache read per 1M tokens');
  assert.equal(priceHint({ input: 0, output: 5, cacheRead: null, cacheWrite: null }), '$0 in · $5 out per 1M tokens');
});
test('tiers', () => {
  assert.equal(tierInfo('upgrade').label, 'Upgrade');
  assert.equal(tierInfo('custom').label, 'custom');
});
