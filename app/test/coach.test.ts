import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryLabel, countBySeverity, orderInsights, severityInfo } from '../src/logic/coach.ts';

const i = (id: string, severity: string, category = 'model') => ({ id, severity, category, title: id, description: '', action: null, impact: null }) as any;
test('orders by severity, keeps backend order within a severity, telemetry last', () => {
  const out = orderInsights([i('t', 'info', 'telemetry'), i('a', 'info'), i('b', 'high'), i('c', 'medium'), i('d', 'high'), i('e', 'info')]);
  assert.deepEqual(out.map((x) => x.id), ['b', 'd', 'c', 'a', 'e', 't']);
});
test('telemetry stays last even when marked high', () => {
  assert.deepEqual(orderInsights([i('t', 'high', 'telemetry'), i('x', 'info')]).map((x) => x.id), ['x', 't']);
});
test('does not mutate its input and handles empty', () => {
  const src = [i('a', 'info'), i('b', 'high')];
  orderInsights(src);
  assert.equal(src[0].id, 'a');
  assert.deepEqual(orderInsights([]), []);
});
test('labels and counts', () => {
  assert.equal(severityInfo('high').label, 'High priority');
  assert.equal(severityInfo('weird').tone, 'accent');
  assert.equal(categoryLabel('reliability'), 'Reliability');
  assert.equal(categoryLabel('x'), 'x');
  assert.deepEqual(countBySeverity([i('a', 'high'), i('b', 'medium'), i('c', 'medium')]), { high: 1, medium: 2 });
});
import { isCommand } from '../src/logic/coach.ts';
test('isCommand separates copyable commands from advice sentences', () => {
  for (const c of ['./claude-gateway-setup.sh model sonnet', 'claude-gateway-setup.sh upgrade', '/model opus', '/effort high', 'bash scripts/set-limit.sh']) assert.equal(isCommand(c), true, c);
  for (const s of ['Slow down on the premium model or ask an admin to adjust the cap.', 'Keep Opus 5.5 for hard problems and use Haiku 5.5 for routine edits.', '', null, undefined]) assert.equal(isCommand(s as any), false, String(s));
});
