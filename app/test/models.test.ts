import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogProblems, matchModel, modelRole, previousRecipe, priceHint, tierInfo, unpinnedFamilyWarnings, usageShares } from '../src/logic/models.ts';

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
  assert.equal(tierInfo('previous').label, 'Previous');
  assert.equal(tierInfo('custom').label, 'custom');
});

// The catalog as GET /api/models returns it: the 4.6 entries are allowed but not pinned.
type M = { alias: string; id: string; tier: string; enabled: boolean; family: 'sonnet' | 'opus' | 'haiku' | null; pinned: boolean };
const E = (alias: string, id: string, tier: string, family: M['family'], pinned: boolean, enabled = true): M => ({ alias, id, tier, enabled, family, pinned });
const shipped = (): M[] => [E('sonnet', 'claude-sonnet-5-5', 'default', 'sonnet', true), E('opus', 'claude-opus-5-5', 'upgrade', 'opus', true), E('haiku', 'claude-haiku-5-5', 'fast', 'haiku', true),
  E('sonnet-4-6', 'claude-sonnet-4-6', 'previous', 'sonnet', false), E('opus-4-6', 'claude-opus-4-6', 'previous', 'opus', false)];
// ...and after the recipe: default sonnet-4-6, pins moved.
const recipe46 = (): M[] => shipped().map((m) => ({ ...m, pinned: m.alias === 'sonnet-4-6' || m.alias === 'opus-4-6' || m.alias === 'haiku' }));

test('4.6 entries: shipped catalog has no problems and each entry has the right role', () => {
  const ms = shipped();
  assert.deepEqual(catalogProblems(ms, 'sonnet'), []);
  assert.deepEqual(ms.map((m) => modelRole(m, 'sonnet')), ['default', 'pinned', 'pinned', 'extra', 'extra']);
  assert.equal(modelRole({ ...ms[3], enabled: false }, 'sonnet'), 'off');
});

test('recipe hint: shown while 4.6 is not pinned, names the edits, gone once it is the default', () => {
  const r = previousRecipe(shipped(), 'sonnet');
  assert.ok(r);
  assert.equal(r!.defaultAlias, 'sonnet-4-6');
  assert.deepEqual(r!.edits, [{ alias: 'sonnet-4-6', pin: true }, { alias: 'sonnet', pin: false }, { alias: 'opus-4-6', pin: true }, { alias: 'opus', pin: false }]);
  assert.equal(previousRecipe(recipe46(), 'sonnet-4-6'), null, 'already switched: nothing to suggest');
  assert.equal(previousRecipe(shipped().slice(0, 3), 'sonnet'), null, 'no previous-generation entries');
  assert.equal(previousRecipe(shipped().map((m) => (m.tier === 'previous' ? { ...m, enabled: false } : m)), 'sonnet'), null, 'disabled entries are not offered');
  assert.deepEqual(catalogProblems(recipe46(), 'sonnet-4-6'), [], 'the recipe result is a valid catalog');
  assert.deepEqual(recipe46().filter((m) => m.pinned).map((m) => m.id), ['claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6']);
  assert.deepEqual(recipe46().map((m) => modelRole(m, 'sonnet-4-6')), ['extra', 'extra', 'pinned', 'default', 'pinned']);
});

test('catalogProblems flags every contradiction the server also refuses', () => {
  const two = shipped().map((m) => (m.alias === 'sonnet-4-6' ? { ...m, pinned: true } : m));
  assert.match(catalogProblems(two, 'sonnet').join(' '), /more than one model pins the sonnet family \(sonnet, sonnet-4-6\)/i);
  assert.match(catalogProblems(shipped(), 'missing').join(' '), /default model "missing" is not in the list/);
  assert.match(catalogProblems(shipped().map((m) => (m.alias === 'sonnet' ? { ...m, enabled: false } : m)), 'sonnet').join(' '), /default model "sonnet" is disabled/);
  const dup = [...shipped(), E('SONNET', 'claude-sonnet-x', 'x', null, false)];
  assert.match(catalogProblems(dup, 'sonnet').join(' '), /aliases must be unique/);
  assert.match(catalogProblems([...shipped(), E('z', 'claude-sonnet-4-6', 'x', null, false)], 'sonnet').join(' '), /ids must be unique/);
  assert.match(catalogProblems([E('a', 'a-1', 'x', 'opus', true, false)], 'a').join(' '), /pinned but disabled/);
});

test('usage shares: a 4.6 request is its own model, never folded into 5.5', () => {
  const r = usageShares(shipped(), [{ model: 'claude-sonnet-5-5', requests: 50, ok: 50 }, { model: 'claude-sonnet-4-6', requests: 30, ok: 29 }, { model: 'claude-opus-4-6-20260101', requests: 20, ok: 20 }]);
  assert.equal(r.by.get('claude-sonnet-5-5')!.requests, 50);
  assert.equal(r.by.get('claude-sonnet-4-6')!.requests, 30);
  assert.equal(r.by.get('claude-opus-4-6')!.requests, 20);
  assert.equal(r.other.length, 0);
});

test('recipe hint: swaps the tiers with the pins so the cards, descriptions and the upgrade step keep telling the truth', () => {
  const r = previousRecipe(shipped(), 'sonnet')!;
  assert.deepEqual(r.tiers, [{ alias: 'sonnet-4-6', tier: 'default' }, { alias: 'sonnet', tier: 'previous' }, { alias: 'opus-4-6', tier: 'upgrade' }, { alias: 'opus', tier: 'previous' }]);
  const swapped = shipped().map((m) => ({ ...m, tier: r.tiers.find((t) => t.alias === m.alias)?.tier ?? m.tier }));
  // after the recipe the 5.5 entries are the "previous" ones, so the card now offers the way back (the same recipe, mirrored)
  const after = previousRecipe(swapped.map((m) => ({ ...m, pinned: m.alias === 'sonnet-4-6' || m.alias === 'opus-4-6' || m.alias === 'haiku' })), 'sonnet-4-6')!;
  assert.equal(after.defaultAlias, 'sonnet');
  assert.deepEqual(after.tiers, [{ alias: 'sonnet', tier: 'default' }, { alias: 'sonnet-4-6', tier: 'previous' }, { alias: 'opus', tier: 'upgrade' }, { alias: 'opus-4-6', tier: 'previous' }]);
  // a family whose pinned entry is itself "previous" needs no tier swap
  const odd = shipped().map((m) => (m.alias === 'sonnet' ? { ...m, tier: 'previous' } : m));
  assert.deepEqual(previousRecipe(odd, 'sonnet')!.tiers.map((t) => t.alias), ['opus-4-6', 'opus']);
});

test('unpinned family warnings: only a family with an enabled entry and no pin', () => {
  assert.deepEqual(unpinnedFamilyWarnings(shipped()), []);
  assert.deepEqual(unpinnedFamilyWarnings(recipe46()), []);
  const w = unpinnedFamilyWarnings(shipped().map((m) => (m.alias === 'sonnet' ? { ...m, pinned: false } : m)));
  assert.equal(w.length, 1);
  assert.match(w[0], /No enabled model pins the sonnet family \(sonnet, sonnet-4-6\)/);
  assert.deepEqual(unpinnedFamilyWarnings(shipped().map((m) => (m.family === 'sonnet' ? { ...m, pinned: false, enabled: false } : m))), [], 'a family with nothing enabled is not a problem');
});
