import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetState } from '../src/logic/budget.ts';

test('budget states and thresholds', () => {
  assert.equal(budgetState(0, 10000, true).key, 'unlimited');
  assert.equal(budgetState(500, null).key, 'nocap');
  assert.equal(budgetState(0, 0).label, 'Blocked');
  assert.equal(budgetState(5900, 10000).key, 'ok');
  assert.equal(budgetState(6000, 10000).key, 'watch');
  assert.equal(budgetState(8500, 10000).key, 'near');
  assert.equal(budgetState(10000, 10000).key, 'over');
  assert.equal(budgetState(12000, 10000).pct, 1.2);
  assert.equal(budgetState(100, 10000).tone, 'good');
});
