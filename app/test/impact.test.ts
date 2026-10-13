import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPersonalCap, orgImpact, peopleWithPersonalCaps } from '../src/logic/impact.ts';

const b = (cap: number | null, spend: number, source: string | null = 'organization', unlimited = false) => ({ capCents: cap, spendCents: spend, source, unlimited });
const none = b(null, 0, null);
const person = (w: any, m: any = b(20000, 0)) => ({ budgets: { daily: none, weekly: w, monthly: m } });
const people = [
  person(b(5000, 1000)), person(b(5000, 4000)), person(b(5000, 6000)),                       // rely on the default
  person(b(12000, 0, 'user')), person(b(null, 0, 'user', true)),                           // personal cap / personal unlimited
];

test('who relies on the default, and people (not rows) with personal caps', () => {
  assert.ok(hasPersonalCap(b(1, 0, 'user'))); assert.ok(hasPersonalCap(b(null, 0, 'user', true))); assert.ok(!hasPersonalCap(b(5000, 0)));
  assert.equal(peopleWithPersonalCaps(people), 2);
  const twoRows = [person(b(12000, 0, 'user'), b(40000, 0, 'user')), person(b(5000, 0))];
  assert.equal(peopleWithPersonalCaps(twoRows), 1);                                       // one person with two limit rows counts once
});
test('M6: $0 blocks everyone relying on the default and needs a confirm', () => {
  const r = orgImpact(people, 'weekly', 5000, 0);
  assert.equal(r.relying, 3); assert.ok(r.allBlocked); assert.ok(r.needsConfirm);
  assert.match(r.lines[0], /^This blocks all 3 people who have no personal cap\.$/);
});
test('M6: a decrease reports who is blocked right away and needs a confirm', () => {
  const r = orgImpact(people, 'weekly', 5000, 3000);
  assert.equal(r.newlyBlocked, 1); assert.ok(r.needsConfirm);          // $40 spent is newly blocked; the $60 person was already over the old cap
  assert.match(r.lines[0], /blocks 1 of 3 people with no personal cap right away/);
  assert.match(r.lines.join(' '), /\$15,000 to \$9,000 \(−\$6,000\)|\$150 to \$90 \(−\$60\)/);
  // someone already blocked at the old cap is not "newly" blocked
  const r2 = orgImpact(people, 'weekly', 5000, 3000); assert.equal(r2.relying, 3);
  const already = orgImpact([person(b(5000, 5000)), person(b(5000, 100))], 'weekly', 5000, 3000); assert.equal(already.newlyBlocked, 0);
});
test('M6: an increase shows the exposure change and does not need a confirm', () => {
  const r = orgImpact(people, 'weekly', 5000, 8000);
  assert.ok(!r.needsConfirm); assert.equal(r.newlyBlocked, 0); assert.equal(r.exposureBefore, 15000); assert.equal(r.exposureAfter, 24000);
  assert.match(r.lines.join(' '), /\$150 to \$240 \(\+\$90\)/);
});
test('M6: removing the default or capping an uncapped company needs thought', () => {
  const rm = orgImpact(people, 'weekly', 5000, null);
  assert.ok(rm.needsConfirm); assert.equal(rm.exposureAfter, null); assert.match(rm.lines[0], /Removing the default leaves 3 people with no cap/);
  const set = orgImpact(people, 'weekly', null, 3000);
  assert.equal(set.newlyBlocked, 2); assert.ok(set.needsConfirm); assert.match(set.lines.join(' '), /capped at \$30 each/);
  const set2 = orgImpact(people, 'weekly', null, 100000); assert.ok(!set2.needsConfirm);
});
test('M6: nobody relies on the default, and the people list failed to load', () => {
  const r = orgImpact([person(b(1, 0, 'user'))], 'weekly', 5000, 0);
  assert.equal(r.relying, 0); assert.match(r.lines[0], /Nobody relies on the default/);
  const f = orgImpact(null, 'weekly', 5000, 0); assert.ok(f.needsConfirm); assert.match(f.lines[0], /blocks everyone/);
  const g = orgImpact(undefined, 'weekly', 5000, 8000); assert.ok(!g.needsConfirm); assert.match(g.lines[0], /Could not load/);
  assert.ok(orgImpact(null, 'weekly', 5000, 4000).needsConfirm);
});
test('L7-style: one person is "1 person", exposure maths is integer cents', () => {
  const one = orgImpact([person(b(5000, 0))], 'monthly', 20000, 0);
  assert.match(one.lines[0], /the 1 person who has no personal cap/);
  const x = orgImpact([person(b(1, 0), b(1999, 0)), person(b(1, 0), b(1999, 0)), person(b(1, 0), b(1999, 0))], 'monthly', 1999, 2999);
  assert.equal(x.exposureBefore, 5997); assert.equal(x.exposureAfter, 8997);
});

import { rebasedBoosts } from '../src/logic/impact.ts';
test('N4: people with a live boost built on the default are counted and re-based text is shown', () => {
  const boosted = (status: string, prev: any, source = 'user') => ({ ...person(b(7000, 100, source)), overrides: [{ status, period: 'weekly', prev }] });
  const list = [boosted('active', { kind: 'none' }), boosted('active', { kind: 'cap', cents: 6000 }), boosted('active', null), boosted('ended', { kind: 'none' }), boosted('scheduled', null, 'organization'), boosted('scheduled', null, 'user'), person(b(5000, 0))];
  assert.equal(rebasedBoosts(list, 'weekly'), 2);              // active on none + scheduled for someone on the default
  assert.equal(rebasedBoosts(list, 'monthly'), 0);
  const r = orgImpact(list, 'weekly', 5000, 8000);
  assert.equal(r.rebased, 2); assert.ok(r.needsConfirm);
  assert.ok(r.lines.includes('2 people with a live boost will have their boost re-based on the new default.'));
  const one = orgImpact([boosted('active', { kind: 'none' })], 'weekly', 5000, 8000);
  assert.match(one.lines.join(' '), /1 person with a live boost will have their boost re-based on the new default\./);
  assert.equal(orgImpact(list, 'weekly', 5000, 5000).rebased, 0);        // unchanged default: nothing to re-base
  assert.equal(orgImpact([person(b(5000, 0))], 'weekly', 5000, 8000).rebased, 0);
});
