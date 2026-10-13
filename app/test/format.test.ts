import test from 'node:test';
import assert from 'node:assert/strict';
import { ago, initials, int, modelShort, pct, plural, span, usd } from '../src/logic/format.ts';

test('usd formats cents, hides cents on whole dollars, handles null and signs', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(undefined), '—');
  assert.equal(usd(5000), '$50');
  assert.equal(usd(5050), '$50.50');
  assert.equal(usd(120000), '$1,200');
  assert.equal(usd(2500, { signed: true }), '+$25');
  assert.equal(usd(-2500), '−$25');
  assert.equal(usd(0), '$0');
});
test('int, pct, plural', () => {
  assert.equal(int(12345), '12,345');
  assert.equal(pct(0.456), '46%');
  assert.equal(plural(1, 'day'), '1 day');
  assert.equal(plural(3, 'day'), '3 days');
});
test('ago buckets', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(ago(null, now), 'never');
  assert.equal(ago('2026-10-13T11:59:50Z', now), 'just now');
  assert.equal(ago('2026-10-13T11:30:00Z', now), '30 min ago');
  assert.equal(ago('2026-10-13T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-10-10T12:00:00Z', now), '3 d ago');
});
test('span uses the two most significant units', () => {
  assert.equal(span(20_000), '<1m');
  assert.equal(span(12 * 60_000), '12m');
  assert.equal(span(3 * 3600_000), '3h');
  assert.equal(span((3 * 60 + 20) * 60_000), '3h 20m');
  assert.equal(span((2 * 24 + 4) * 3600_000), '2d 4h');
  assert.equal(span(2 * 86400_000), '2d');
  assert.equal(span(-5), '<1m');
});
test('names', () => {
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('ada.lovelace@x.com'), 'AL');
  assert.equal(initials(''), '');                        // callers draw a neutral glyph, not '?'
  assert.equal(initials(null), ''); assert.equal(initials('\u202e'), '');
  assert.equal(modelShort('claude-sonnet-5-5'), 'sonnet-5-5');
  assert.equal(modelShort('claude-haiku-4-5-20251001'), 'haiku-4-5');
});

import { firstGlyph, pctUsed, longSpan } from '../src/logic/format.ts';
import { budgetState } from '../src/logic/budget.ts';
test('N10b: initials never split emoji or surrogate pairs', () => {
  assert.equal(initials('😀 Happy'), '😀H'); assert.equal(initials('😀'), '😀'); assert.equal(initials('𝓐da 𝓛ovelace'), '𝓐𝓛');
  assert.equal(initials('👨‍👩‍👧 Family'), '👨‍👩‍👧F'); assert.equal(initials('🇬🇧 uk'), '🇬🇧U'); assert.equal(firstGlyph(''), '');
  for (const n of ['😀', '😀😀 x', '𝓐', 'a😀']) assert.doesNotMatch(initials(n), /\ufffd/);
  assert.equal(initials('élan vital'), 'ÉV');
});
test('N10a: money and percent helpers never crash or print NaN', () => {
  for (const bad of [null, undefined, NaN, Infinity]) {
    assert.equal(int(bad as any), '—'); assert.equal(pct(bad as any), '—'); assert.equal(usd(bad as any), '—'); assert.equal(pctUsed(bad as any), '0%');
  }
  assert.equal(span(NaN), '<1m'); assert.equal(longSpan(NaN), 'under a minute'); assert.equal(ago('not a date'), 'unknown');
  const s = budgetState(null as any, 15000); assert.equal(s.key, 'ok'); assert.equal(s.pct, 0);
  assert.equal(budgetState(100, NaN as any).key, 'nocap'); assert.equal(budgetState(undefined as any, undefined as any).key, 'nocap');
});
