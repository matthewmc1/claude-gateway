import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoach } from '../lib/coach.mjs';
import { MODELS } from './api-helpers.mjs';

const catalog = { default: MODELS.default, models: MODELS.models };
const NOW = Date.parse('2026-03-20T12:00:00Z');       // day 19.5 of 31 (UTC)
const user = { sub: 'u1', email: 'u1@example.com', name: 'U One' };
const b = (cap, spend, extra = {}) => ({ capCents: cap, spendCents: spend, source: 'organization', limitId: 'x', unlimited: false, ...extra });
const m = (model, requests, ok = requests) => ({ model, requests, ok, p50: 800 });
const mix = (sonnet, opus, haiku) => [m('claude-sonnet-5-5', sonnet), m('claude-opus-5-5', opus), m('claude-haiku-5-5', haiku)].filter((x) => x.requests);
const run = (over = {}) => buildCoach({ user, budgets: { daily: b(null, 0), weekly: b(15000, 3000), monthly: b(50000, 10000) }, detail: { models: mix(40, 10, 10), recent: [] }, range: '7d', catalog, overrides: [], now: NOW, ...over });
const ids = (c) => c.insights.map((i) => i.id);
const get = (c, id) => c.insights.find((i) => i.id === id);
const recent = (outcomes, cause = null) => outcomes.map((o, i) => ({ ts: new Date(NOW - i * 60e3).toISOString(), id: 'r' + i, model: 'claude-sonnet-5-5', outcome: o, status: o === 'ok' ? 200 : 500, ms: 500, lt: false, cause: o === 'upstream_error' ? cause : null }));

test('always includes the telemetry insight, last among equals, and a summary string', () => {
  for (const c of [run(), run({ detail: {}, budgets: {} }), run({ detail: { models: [], recent: [] } })]) {
    const t = get(c, 'telemetry-unavailable');
    assert.equal(t.severity, 'info'); assert.equal(t.category, 'telemetry'); assert.match(t.description, /telemetry/);
    assert.equal(typeof c.summary, 'string'); assert.ok(c.summary.length > 5);
    for (const i of c.insights) { assert.ok(['info', 'medium', 'high'].includes(i.severity)); assert.ok(['model', 'reliability', 'budget', 'telemetry'].includes(i.category)); assert.ok('action' in i && 'impact' in i); }
  }
  const c = run({ detail: { models: [], recent: [] } });
  assert.match(c.summary, /No requests/);
});

test('model share: heavy premium use fires, balanced use does not', () => {
  const heavy = run({ detail: { models: mix(10, 50, 0), recent: [] } });
  const i = get(heavy, 'model-upgrade-heavy');
  assert.equal(i.severity, 'medium'); assert.equal(i.category, 'model'); assert.match(i.description, /83\.3%/);   // percentages under 100 are floored to one decimal (was rounded to 83%)
  assert.match(i.impact, /5\.0x/, 'price ratio from the catalog output prices');
  assert.match(i.action, /Sonnet 5\.5/);
  assert.equal(get(run(), 'model-upgrade-heavy'), undefined);
  assert.equal(get(run({ detail: { models: mix(2, 10, 0), recent: [] } }), 'model-upgrade-heavy'), undefined, 'too little data');
  // escalates when the budget is also nearly gone
  const hot = run({ detail: { models: mix(10, 50, 0), recent: [] }, budgets: { weekly: b(15000, 14000), monthly: b(50000, 10000) } });
  assert.equal(get(hot, 'model-upgrade-heavy').severity, 'high');
  // no prices -> no impact claim
  const noPrice = run({ detail: { models: mix(10, 50, 0), recent: [] }, catalog: { default: 'sonnet', models: MODELS.models.map((x) => ({ ...x, pricePerMTok: {} })) } });
  assert.equal(get(noPrice, 'model-upgrade-heavy').impact, null);
});

test('unused cheaper tier fires only with enough traffic and zero use', () => {
  assert.ok(get(run({ detail: { models: mix(40, 10, 0), recent: [] } }), 'model-fast-unused'));
  assert.equal(get(run({ detail: { models: mix(40, 10, 3), recent: [] } }), 'model-fast-unused'), undefined);
  assert.equal(get(run({ detail: { models: mix(20, 5, 0), recent: [] } }), 'model-fast-unused'), undefined, 'under 30 requests');
  assert.equal(get(run({ catalog: { default: 'sonnet', models: MODELS.models.filter((x) => x.tier !== 'fast') }, detail: { models: mix(40, 10, 0), recent: [] } }), 'model-fast-unused'), undefined, 'no fast model offered');
});

test('model ids with version suffixes still map to a tier', () => {
  const c = run({ detail: { models: [m('claude-opus-5-5@20260101', 40), m('claude-sonnet-5-5', 10)], recent: [] } });
  assert.ok(get(c, 'model-upgrade-heavy'));
});

test('reliability: provider errors, spend cap blocks, rejected requests', () => {
  const quiet = run({ detail: { models: mix(40, 10, 10), recent: recent(Array(20).fill('ok')) } });
  assert.ok(!ids(quiet).some((x) => x.startsWith('reliability')));

  const up = run({ detail: { models: mix(40, 10, 10), recent: recent(['upstream_error', 'upstream_error', 'upstream_error', ...Array(12).fill('ok')], 'quota exceeded') } });
  const i = get(up, 'reliability-provider-errors');
  assert.equal(i.severity, 'medium'); assert.match(i.description, /quota exceeded/); assert.match(i.description, /3 of your last 15/);
  assert.equal(get(run({ detail: { models: mix(40, 10, 10), recent: recent(['upstream_error', 'upstream_error', ...Array(20).fill('ok')]) } }), 'reliability-provider-errors'), undefined, '2 errors is noise');
  assert.equal(get(run({ detail: { models: mix(40, 10, 10), recent: recent(Array(8).fill('upstream_error').concat(['ok', 'ok'])) } }), 'reliability-provider-errors').severity, 'high');

  const cap = run({ detail: { models: mix(40, 10, 10), recent: recent(['spend_cap', 'ok', 'ok']) } });
  assert.equal(get(cap, 'reliability-spend-cap').severity, 'high'); assert.match(get(cap, 'reliability-spend-cap').description, /1 of your last 3/);

  const rej = run({ detail: { models: mix(40, 10, 10), recent: recent(['rejected', 'rejected', 'rejected', 'ok', 'ok']) } });
  assert.equal(get(rej, 'reliability-rejected').severity, 'medium');
  assert.equal(get(run({ detail: { models: mix(40, 10, 10), recent: recent(['rejected', 'rejected', ...Array(20).fill('ok')]) } }), 'reliability-rejected'), undefined);
});

test('budget: ok / near / exhausted per period with remaining and percent', () => {
  const ok = run();
  assert.equal(get(ok, 'budget-ok-weekly').severity, 'info'); assert.match(get(ok, 'budget-ok-weekly').description, /20% used: \$30 of \$150, with \$120 left/);
  const near = run({ budgets: { weekly: b(15000, 13000), monthly: b(50000, 10000) } });
  assert.equal(get(near, 'budget-near-weekly').severity, 'medium'); assert.match(get(near, 'budget-near-weekly').description, /86\.6% used/);   // floored, never rounded up (was 87%) assert.equal(get(near, 'budget-ok-weekly'), undefined);
  const out = run({ budgets: { weekly: b(15000, 15000), monthly: b(50000, 10000) } });
  assert.equal(get(out, 'budget-exhausted-weekly').severity, 'high'); assert.ok(out.summary.includes('weekly budget is used up'));
  assert.equal(get(run({ budgets: { weekly: b(15000, 99999), monthly: b(50000, 0) } }), 'budget-exhausted-weekly').severity, 'high');
  assert.equal(get(run({ budgets: { weekly: b(0, 0), monthly: b(0, 5) } }), 'budget-exhausted-monthly').severity, 'high');
  // no cap and unlimited
  const un = run({ budgets: { weekly: b(null, 500, { unlimited: true }), monthly: b(null, 100, { unlimited: true }) } });
  assert.ok(get(un, 'budget-unlimited')); assert.equal(get(un, 'budget-ok-weekly'), undefined);
  assert.equal(ids(run({ budgets: {} })).filter((x) => x.startsWith('budget')).length, 0);
});

test('monthly pace projection: monthly only, not too early, escalates', () => {
  // day 19.5 of 31: $100 spent -> ~$159 projected; $350 -> ~$556
  const fine = run({ budgets: { weekly: b(15000, 1000), monthly: b(50000, 10000) } });
  assert.equal(get(fine, 'budget-pace-monthly').severity, 'info');
  const over = run({ budgets: { weekly: b(15000, 1000), monthly: b(50000, 35000) } });
  const p = get(over, 'budget-pace-monthly');
  assert.equal(p.severity, 'medium'); assert.match(p.description, /\$556/); assert.match(p.title, /exceed/);
  assert.equal(get(run({ budgets: { weekly: b(15000, 1000), monthly: b(50000, 40000) } }), 'budget-pace-monthly').severity, 'high');
  assert.equal(get(run({ now: Date.parse('2026-03-02T12:00:00Z'), budgets: { weekly: b(15000, 1000), monthly: b(50000, 40000) } }), 'budget-pace-monthly'), undefined, 'under 3 days in: too noisy');
  assert.equal(get(run({ budgets: { weekly: b(15000, 1000), monthly: b(50000, 0) } }), 'budget-pace-monthly'), undefined, 'nothing spent');
  assert.equal(get(run({ budgets: { weekly: b(15000, 14000), monthly: null } }), 'budget-pace-monthly'), undefined);
  assert.ok(!ids(over).some((x) => /pace.*weekly|weekly.*pace/.test(x)), 'never a weekly projection');
  assert.equal(get(run({ budgets: { weekly: b(15000, 1000), monthly: b(50000, 50000) } }), 'budget-pace-monthly'), undefined, 'exhausted already says it');
});

test('an active boost is mentioned in the budget insights', () => {
  const ov = [{ id: 'ovr_1', status: 'active', period: 'weekly', extraCents: 5000, endsAt: '2026-03-25T00:00:00.000Z' }, { id: 'ovr_2', status: 'scheduled', period: 'monthly', extraCents: 9900, endsAt: '2026-04-01T00:00:00.000Z' }];
  const c = run({ overrides: ov });
  assert.match(get(c, 'budget-ok-weekly').description, /boost of \$50 .* until 2026-03-25/);
  assert.doesNotMatch(get(c, 'budget-ok-monthly').description, /boost/);
});

test('ordering: severity first, then stable rule order; ids are unique and deterministic', () => {
  const c = run({ detail: { models: mix(10, 50, 0), recent: recent(['spend_cap', 'ok']) }, budgets: { weekly: b(15000, 15000), monthly: b(50000, 10000) } });
  const sev = c.insights.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort((x, y) => ({ high: 0, medium: 1, info: 2 })[x] - ({ high: 0, medium: 1, info: 2 })[y]));
  assert.equal(new Set(ids(c)).size, ids(c).length);
  assert.deepEqual(ids(c), ids(run({ detail: { models: mix(10, 50, 0), recent: recent(['spend_cap', 'ok']) }, budgets: { weekly: b(15000, 15000), monthly: b(50000, 10000) } })));
  assert.match(c.summary, /worth a look/);
});

test('survives missing and odd input', () => {
  assert.doesNotThrow(() => buildCoach({}));
  assert.doesNotThrow(() => buildCoach({ user, budgets: { weekly: { capCents: 'x' } }, detail: { models: [{}], recent: [{}] }, catalog: null, overrides: [] }));
  assert.ok(get(buildCoach({}), 'telemetry-unavailable'));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Data-integrity regressions (adversarial review M9, L4)
// ---------------------------------------------------------------------------------------------------------------------------------
test('M9: a $0 cap is "blocked", never "on track" (whether or not anything was spent)', () => {
  for (const spend of [0, 1]) {
    const c = run({ budgets: { weekly: b(0, spend), monthly: b(50000, 100) } });
    const i = get(c, 'budget-exhausted-weekly');
    assert.equal(i.severity, 'high'); assert.match(i.title, /\$0.*blocked/); assert.match(i.description, /every request is blocked/);
    assert.equal(get(c, 'budget-ok-weekly'), undefined); assert.equal(get(c, 'budget-near-weekly'), undefined);
    assert.ok(!c.summary.includes('Nothing urgent'));
  }
  assert.equal(get(run({ budgets: { weekly: b(0, 0), monthly: b(0, 0) } }), 'budget-pace-monthly'), undefined, 'no pace talk about a $0 cap');
});

test('M9: percentages under 100 are never rounded up to 100 ("99.6% used", not "100% used"); 100 and over are shown as such', () => {
  const near = run({ budgets: { weekly: b(15000, 14940), monthly: b(50000, 100) } });
  assert.match(get(near, 'budget-near-weekly').description, /^99\.6% used/); assert.doesNotMatch(get(near, 'budget-near-weekly').description, /100%/);
  assert.match(get(run({ budgets: { weekly: b(15000, 14999), monthly: b(50000, 100) } }), 'budget-near-weekly').description, /^99\.9% used/);
  assert.match(get(run({ budgets: { weekly: b(15000, 12000), monthly: b(50000, 100) } }), 'budget-near-weekly').description, /^80% used/);
  assert.equal(get(run({ budgets: { weekly: b(15000, 15000), monthly: b(50000, 100) } }), 'budget-exhausted-weekly').severity, 'high');
});

test('M9: an exhausted DAILY cap is reported (it was ignored), and a daily cap near its limit warns', () => {
  const out = run({ budgets: { daily: b(500, 500), weekly: b(15000, 3000), monthly: b(50000, 100) } });
  assert.equal(get(out, 'budget-exhausted-daily').severity, 'high'); assert.match(get(out, 'budget-exhausted-daily').title, /daily budget is used up/);
  assert.match(out.summary, /daily budget is used up/);
  assert.equal(get(run({ budgets: { daily: b(500, 450), weekly: b(15000, 3000), monthly: b(50000, 100) } }), 'budget-near-daily').severity, 'medium');
  assert.equal(get(run({ budgets: { daily: b(500, 100), weekly: b(15000, 3000), monthly: b(50000, 100) } }), 'budget-ok-daily').severity, 'info');
  assert.equal(get(run({ budgets: { daily: b(500, 100), weekly: b(15000, 3000), monthly: b(50000, 100) } }), 'budget-pace-daily'), undefined, 'pace is monthly only');
});

test('M9: no pace projection with less than 3 days of the month gone', () => {
  const at = (iso, spend) => run({ now: Date.parse(iso), budgets: { monthly: b(50000, spend) } });
  assert.equal(get(at('2026-10-02T12:00:00Z', 30000), 'budget-pace-monthly'), undefined, '1.5 days');
  assert.equal(get(at('2026-10-03T23:59:00Z', 30000), 'budget-pace-monthly'), undefined, '2.99 days');
  assert.ok(get(at('2026-10-04T00:00:00Z', 30000), 'budget-pace-monthly'), 'exactly 3 days');
});

test('M9: thin data never produces "mostly Opus": one request, or fewer than 10 premium requests, says nothing', () => {
  assert.equal(get(run({ detail: { models: [m('claude-opus-5-5', 1)], recent: [] } }), 'model-upgrade-heavy'), undefined);
  assert.equal(get(run({ detail: { models: [m('claude-opus-5-5', 9), m('claude-sonnet-5-5', 5)], recent: [] } }), 'model-upgrade-heavy'), undefined);
  assert.equal(get(run({ detail: { models: mix(10, 10, 0), recent: [] } }), 'model-upgrade-heavy'), undefined, 'exactly half is not "most"');
  assert.ok(get(run({ detail: { models: mix(9, 11, 0), recent: [] } }), 'model-upgrade-heavy'));
  assert.equal(get(run({ detail: { models: [m('claude-sonnet-5-5', 5)], recent: [] } }), 'model-fast-unused'), undefined);
});

test('M9/L4: recent requests outside the selected range are ignored (a 3-week-old block is not a High alarm today)', () => {
  const old = { ts: new Date(NOW - 20 * 86400e3).toISOString(), id: 'o', model: 'claude-sonnet-5-5', outcome: 'spend_cap', status: 429, ms: 5, lt: false, cause: null };
  const c = run({ range: '7d', detail: { models: mix(40, 10, 10), recent: [...recent(Array(20).fill('ok')), old] } });
  assert.equal(get(c, 'reliability-spend-cap'), undefined);
  const day = run({ range: '24h', detail: { models: mix(40, 10, 10), recent: [{ ...old, ts: new Date(NOW - 3 * 3600e3).toISOString() }, ...recent(['ok', 'ok'])] } });
  assert.equal(get(day, 'reliability-spend-cap').severity, 'high', 'a block three hours ago in a 24h view is real');
  const week = run({ range: '7d', detail: { models: mix(40, 10, 10), recent: [{ ...old, ts: new Date(NOW - 3 * 86400e3).toISOString() }, ...recent(['ok', 'ok'])] } });
  assert.equal(get(week, 'reliability-spend-cap').severity, 'medium', 'inside the range but older than a day: worth a look, not an alarm');
});

test('policy rejections are named as such, and requests without a model do not skew the model mix', () => {
  const c = run({ detail: { models: [...mix(10, 12, 0), m('(none)', 40, 0)], recent: recent(['rejected', 'rejected', 'rejected', 'ok', 'ok']) } });
  assert.match(get(c, 'reliability-rejected').description, /policy rejections/); assert.doesNotMatch(get(c, 'reliability-rejected').description, /\(none\)/);
  const mixIns = get(c, 'model-upgrade-heavy'); assert.ok(mixIns, '12 of 22 modelled requests (not 12 of 62) used Opus'); assert.match(mixIns.description, /54\.5% of your 22 requests/);
});
