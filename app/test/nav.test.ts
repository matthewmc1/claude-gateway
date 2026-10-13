import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_META, hashFor, needsGate, pageTitle, parseHash, pickDefaultUser, themeFromSearch } from '../src/logic/nav.ts';

test('sections are in the agreed order', () => {
  assert.deepEqual(TAB_META.map((t) => t.label), ['People', 'My usage & coach', 'Company', 'Models', 'Activity']);
});
test('parseHash', () => {
  assert.deepEqual(parseHash(''), { tab: 'people', sub: null });
  assert.deepEqual(parseHash('#/my-usage'), { tab: 'my-usage', sub: null });
  assert.deepEqual(parseHash('#/people/abc%20d'), { tab: 'people', sub: 'abc d' });
  assert.deepEqual(parseHash('#/company/xyz'), { tab: 'company', sub: null });
  assert.deepEqual(parseHash('#/nonsense'), { tab: 'people', sub: null });
  assert.deepEqual(parseHash('#/people/%E0%A4%A'), { tab: 'people', sub: '%E0%A4%A' });
});
test('hashFor round-trips', () => {
  assert.equal(hashFor('models'), '/models');
  assert.deepEqual(parseHash('#' + hashFor('people', 'a/b')), { tab: 'people', sub: 'a/b' });
});
test('page titles', () => { assert.equal(pageTitle('activity'), 'Budget activity · Gateway Budgets'); });
test('themeFromSearch', () => {
  assert.equal(themeFromSearch('?theme=light'), 'light');
  assert.equal(themeFromSearch('?x=1&theme=dark'), 'dark');
  assert.equal(themeFromSearch('?theme=pink'), null);
  assert.equal(themeFromSearch(''), null);
});
test('pickDefaultUser: remembered, then admin email, then first', () => {
  const users = [{ sub: 'a', email: 'a@x.com' }, { sub: 'b', email: 'Bee@x.com' }, { sub: 'c', email: null }];
  assert.equal(pickDefaultUser([], 'a', null), null);
  assert.equal(pickDefaultUser(users, 'c', 'bee@x.com'), 'c');
  assert.equal(pickDefaultUser(users, 'gone', 'bee@x.com'), 'b');
  assert.equal(pickDefaultUser(users, null, 'nobody@x.com'), 'a');
  assert.equal(pickDefaultUser(users, null, null), 'a');
});
test('needsGate only when reads need admin and nobody is signed in', () => {
  assert.equal(needsGate('admin', null), true);
  assert.equal(needsGate('admin', { email: 'x' }), false);
  assert.equal(needsGate('open', null), false);
  assert.equal(needsGate(undefined, null), false);
});
