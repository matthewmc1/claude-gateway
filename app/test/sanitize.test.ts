import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBudget, cleanBudgets, cleanSpend, finite, list } from '../src/logic/sanitize.ts';
import { PAGE, pageWindow } from '../src/logic/list.ts';
import { budgetState } from '../src/logic/budget.ts';

test('N10a: malformed numbers from the API are neutralised at the edge', () => {
  assert.deepEqual(cleanBudget({ capCents: null, spendCents: null as any, source: undefined as any }), { capCents: null, spendCents: 0, source: null, limitId: null, unlimited: false });
  assert.equal(cleanBudget({ capCents: NaN, spendCents: 'x' as any }).capCents, null); assert.equal(cleanBudget({ capCents: -5, spendCents: -1 }).capCents, null); assert.equal(cleanBudget({ spendCents: -1 }).spendCents, 0);
  assert.equal(cleanBudget({ capCents: 0, spendCents: 5 }).capCents, 0);
  const bs = cleanBudgets({ weekly: { capCents: 100, spendCents: null as any } as any }); assert.equal(bs.weekly.spendCents, 0); assert.equal(bs.monthly.capCents, null); assert.equal(bs.daily.unlimited, false);
  assert.deepEqual(cleanBudgets(null).weekly, cleanBudget(null));
  assert.equal(finite(NaN, 7), 7); assert.equal(finite('3'), 0); assert.equal(finite(3), 3);
  assert.deepEqual(cleanSpend({ spendCents: null }), { spendCents: 0, committedCents: 0, uncappedUsers: 0 });
  assert.deepEqual(list(null), []); assert.deepEqual(list({} as any), []); assert.deepEqual(list([1]), [1]);
  // and a cleaned budget always yields a state, never a crash
  const b = cleanBudget({ capCents: null, spendCents: null as any }); assert.equal(budgetState(b.spendCents, b.capCents, b.unlimited).key, 'nocap');
});
test('N10c: the People list is windowed 60 at a time', () => {
  assert.equal(PAGE, 60);
  assert.deepEqual(pageWindow(5000, 60), { count: 60, left: 4940, next: 120 });
  assert.deepEqual(pageWindow(5000, 4980), { count: 4980, left: 20, next: 5000 });
  assert.deepEqual(pageWindow(30, 60), { count: 30, left: 0, next: 30 });
  assert.deepEqual(pageWindow(0, 60), { count: 0, left: 0, next: 0 });
  assert.equal(pageWindow(100, NaN).count, 0);
  let shown = PAGE, clicks = 0; while (pageWindow(200, shown).left > 0) { shown = pageWindow(200, shown).next; clicks++; }
  assert.equal(shown, 200); assert.equal(clicks, 3);
});
