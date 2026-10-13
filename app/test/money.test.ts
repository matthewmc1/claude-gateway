import test from 'node:test';
import assert from 'node:assert/strict';
import { centsToText, centsToUsd, parseDays, parseMoney, sanitizeMoneyInput } from '../src/logic/money.ts';
import { usd, pctUsed, plain, oneLine, longSpan } from '../src/logic/format.ts';

const ok = (s: string, cents: number, opts?: any) => { const p = parseMoney(s, opts); assert.ok(p.ok, `${s} -> ${JSON.stringify(p)}`); assert.equal((p as any).cents, cents, s); };
const bad = (s: string, re?: RegExp, opts?: any) => { const p = parseMoney(s, opts); assert.equal(p.ok, false, `${s} should be rejected`); if (re) assert.match((p as any).error ?? '', re, s); };

test('parseMoney accepts digits with at most one dot and two decimals, in integer cents', () => {
  ok('50', 5000); ok('12.5', 1250); ok('12.50', 1250); ok('0', 0); ok('0.05', 5); ok('5.', 500); ok('.5', 50); ok('1000.05', 100005);
  ok('19.99', 1999); ok('1.005'.slice(0, 4), 100); ok('100000', 10_000_000);
});
test('parseMoney never silently turns other text into a number', () => {
  bad('1e3', /scientific|1e3/i); bad('1E3', /scientific/i); bad('-5', /negative/); bad('−5', /negative/); bad('0x10', /digits/i); bad('1.234', /2 decimal/);
  bad('1.2.3'); bad('abc'); bad('12abc'); bad('٥٠'); bad('5 0 5x'); bad('.'); bad('--5'); bad('1_000'); bad('NaN'); bad('Infinity'); bad('1,5'); bad('1 000', /No spaces/); bad('1\u00a0000', /No spaces/); bad('12 .5', /No spaces/); bad('1 0');
  bad('100000.01', /most you can enter/); bad('99999999999999');
});
test('parseMoney: blank is not an error message, zero can be refused', () => {
  assert.deepEqual(parseMoney(''), { ok: false, error: null });
  assert.deepEqual(parseMoney('   '), { ok: false, error: null });
  bad('0', /above zero/, { allowZero: false }); bad('0.00', /above zero/, { allowZero: false });
  bad('600', /most you can enter/, { max: 500 });
});
test('paste sanitising strips only what cannot change the amount', () => {
  assert.equal(sanitizeMoneyInput(' $1,000.50 '), '1000.50');
  assert.equal(sanitizeMoneyInput('$ 25'), '25');
  assert.equal(sanitizeMoneyInput('  25  '), '25');
  assert.equal(sanitizeMoneyInput('1,5'), '1,5');            // ambiguous: left for the validator to reject
  assert.equal(sanitizeMoneyInput('1e3'), '1e3');
  assert.equal(sanitizeMoneyInput('-5'), '-5');
  assert.equal(sanitizeMoneyInput('1‮00'), '100');       // bidi override is invisible, removed
  ok('$1,234.56', 123456);
});
test('cents <-> text round trips with no float drift', () => {
  for (const c of [0, 1, 5, 99, 100, 101, 1999, 100005, 10_000_000, 1005]) { assert.equal(parseMoney(centsToText(c)).ok && (parseMoney(centsToText(c)) as any).cents, c); }
  assert.equal(centsToText(1250), '12.50'); assert.equal(centsToText(5000), '50'); assert.equal(centsToText(5), '0.05');
  assert.equal(centsToUsd(1005), 10.05); assert.equal(centsToUsd(1999), 19.99); assert.equal(centsToUsd(29), 0.29);
  assert.equal(String(centsToUsd(110)), '1.1');           // JSON-safe shortest form, never 1.1000000000000001
});
test('usd is consistent: whole dollars bare, otherwise always two decimals, grouped', () => {
  assert.equal(usd(100050), '$1,000.50'); assert.equal(usd(100000), '$1,000'); assert.equal(usd(1), '$0.01'); assert.equal(usd(123456), '$1,234.56');
  assert.equal(usd(99999999), '$999,999.99'); assert.equal(usd(-150), '−$1.50'); assert.equal(usd(5, { signed: true }), '+$0.05'); assert.equal(usd(NaN), '—');
  assert.equal(usd(1999.4), '$19.99');
});
test('percent used never rounds 99.6% up to 100%', () => {
  assert.equal(pctUsed(0.996), '99%'); assert.equal(pctUsed(1), '100%'); assert.equal(pctUsed(1.004), '100%'); assert.equal(pctUsed(0.5), '50%'); assert.equal(pctUsed(0), '0%');
});
test('parseDays', () => {
  assert.deepEqual(parseDays('5'), { ok: true, days: 5 }); assert.deepEqual(parseDays('0.5'), { ok: true, days: 0.5 });
  for (const b of ['0', '-1', '1e1', 'abc', '1.234', '99999']) assert.equal(parseDays(b).ok, false, b);
  assert.deepEqual(parseDays(''), { ok: false, error: null });
});
test('plain() removes bidi overrides, zero-width and control characters but keeps text and newlines', () => {
  assert.equal(plain('abc‮def‬'), 'abcdef'); assert.equal(plain('a​b⁦c⁩'), 'abc'); assert.equal(plain('x\u0000y\u0007z'), 'xyz');
  assert.equal(plain('line1\nline2'), 'line1\nline2'); assert.equal(plain('<b>hi</b> & "q"'), '<b>hi</b> & "q"'); assert.equal(plain('日本語 😀'), '日本語 😀');
  assert.equal(oneLine('  a \n\n b\t c ‮'), 'a b c');
});
test('longSpan', () => {
  assert.equal(longSpan(30_000), 'under a minute'); assert.equal(longSpan(12 * 60_000), '12 min'); assert.equal(longSpan(2 * 3600_000), '2 h');
  assert.equal(longSpan(26 * 3600_000), '1 d 2 h'); assert.equal(longSpan(5 * 86400_000), '5 d');
});

test('N10d: interior spaces are rejected, not silently joined', () => {
  assert.equal(parseMoney('1 000').ok, false); assert.equal(parseMoney('1  000').ok, false); assert.equal(parseMoney('$ 1 000').ok, false);
  assert.equal(parseMoney(' 1000 ').ok, true); assert.equal(parseDays('1 0').ok, false); assert.equal(parseDays(' 7 ').ok, true);
});
