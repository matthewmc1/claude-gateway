// "Coach": plain-language observations for one engineer, built only from data we really have
// (model mix, request outcomes, budget position). Token and prompt-cache coaching needs client telemetry that does not exist yet,
// so the last insight says so instead of guessing.
//
// buildCoach({ user, budgets, detail, range, catalog, overrides, now }) -> { summary, insights:[Insight] }
// Insight = { id, severity:'info'|'medium'|'high', category:'model'|'reliability'|'budget'|'telemetry', title, description, action|null, impact|null }
// Ids are stable (the UI may key on them); severity depends only on the data.

const DAY = 86400e3;
const SEV = { high: 0, medium: 1, info: 2 };
const RANGE_LABEL = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' };
const PERIOD_LABEL = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };
const RANGE_MS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const MIN_PACE_DAYS = 3;                                           // no monthly projection before this many days of the month have passed
const MIN_MODEL_REQUESTS = 20, MIN_UPGRADE_REQUESTS = 10;          // thin data must not produce "mostly Opus"
const isNoModel = (m) => !m || m === '(none)';                     // requests refused by policy before a model was chosen

const usd = (cents) => {
  const v = (Number(cents) || 0) / 100;
  return '$' + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Number.isInteger(v) ? String(v) : v.toFixed(2));
};
// Percent for display. Under 100% it is FLOORED to one decimal, so 99.6% never reads "100% used" while there is still room.
const pct = (x) => { const v = x * 100; return (v < 100 ? Math.floor(v * 10 + 1e-9) / 10 : Math.round(v)) + '%'; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function tierOf(catalog, model) {
  const m = String(model || '');
  const list = catalog?.models || [];
  return list.find((c) => c.id === m || c.alias === m) || list.find((c) => c.id && m.startsWith(c.id)) || list.find((c) => c.alias && m.toLowerCase().includes(c.alias.toLowerCase())) || null;
}

export function buildCoach({ user, budgets = {}, detail = {}, range = '7d', catalog, overrides = [], now = Date.now() } = {}) {
  const insights = [];
  const add = (i) => insights.push({ action: null, impact: null, ...i });
  const window = RANGE_LABEL[range] || RANGE_LABEL['7d'];
  const models = Array.isArray(detail.models) ? detail.models : [];
  // outcomes of the most recent requests, limited to the selected range (a block from three weeks ago says nothing about the last 24 hours)
  const since = now - (RANGE_MS[range] || RANGE_MS['7d']);
  const recent = (Array.isArray(detail.recent) ? detail.recent : []).filter((r) => { const t = Date.parse(r?.ts); return !Number.isFinite(t) || (t >= since && t <= now + 5 * 60e3); });
  const total = models.reduce((a, m) => a + (Number(m.requests) || 0), 0);
  const okTotal = models.reduce((a, m) => a + (Number(m.ok) || 0), 0);
  const entries = (catalog?.models || []).filter((m) => m.enabled !== false);
  const dflt = entries.find((m) => m.alias === catalog?.default) || entries.find((m) => m.tier === 'default') || null;
  const upgrade = entries.find((m) => m.tier === 'upgrade') || null;
  const fast = entries.find((m) => m.tier === 'fast') || null;

  const byTier = { default: 0, upgrade: 0, fast: 0, other: 0 };
  let modelled = 0;                                                // requests that actually reached a model (policy rejections have none)
  for (const m of models) { if (isNoModel(m.model)) continue; const t = tierOf(catalog, m.model)?.tier; byTier[t in byTier ? t : 'other'] += Number(m.requests) || 0; modelled += Number(m.requests) || 0; }
  const policyRejected = models.filter((m) => isNoModel(m.model)).reduce((a, m) => a + (Number(m.requests) || 0), 0);
  const upgradeShare = modelled ? byTier.upgrade / modelled : 0;
  const maxBudgetPct = Math.max(0, ...['daily', 'weekly', 'monthly'].map((p) => { const b = budgets[p]; return b && b.capCents ? b.spendCents / b.capCents : 0; }));

  // ---- model choice ----
  if (upgrade && modelled >= MIN_MODEL_REQUESTS && byTier.upgrade >= MIN_UPGRADE_REQUESTS && upgradeShare > 0.5) {
    const heavy = upgradeShare >= 0.75 && maxBudgetPct >= 0.9;
    const outRatio = upgrade.pricePerMTok?.output && dflt?.pricePerMTok?.output ? upgrade.pricePerMTok.output / dflt.pricePerMTok.output : null;
    add({
      id: 'model-upgrade-heavy', severity: heavy ? 'high' : 'medium', category: 'model',
      title: `Most requests go to ${upgrade.label}`,
      description: `${pct(upgradeShare)} of your ${plural(modelled, 'request')} in the ${window} used ${upgrade.label}, the premium model. It is built for the hardest problems and uses budget faster.`,
      action: dflt ? `Keep ${upgrade.label} for hard problems and use ${dflt.label} for routine edits and questions.` : `Reserve ${upgrade.label} for hard problems.`,
      impact: outRatio && outRatio > 1 ? `${upgrade.label} output tokens cost about ${outRatio.toFixed(outRatio < 10 ? 1 : 0)}x ${dflt.label}.` : null,
    });
  }
  if (fast && modelled >= 30 && byTier.fast === 0) {
    add({
      id: 'model-fast-unused', severity: 'info', category: 'model',
      title: `You have not tried ${fast.label}`,
      description: `None of your ${plural(modelled, 'request')} in the ${window} used ${fast.label}. ${fast.description || ''}`.trim(),
      action: `Try ${fast.label} for simple, repetitive tasks such as renames, formatting and short lookups.`,
    });
  }

  // ---- reliability (outcomes of the most recent requests) ----
  const n = recent.length;
  const count = (o) => recent.filter((r) => r.outcome === o).length;
  const up = count('upstream_error'), capBlocked = count('spend_cap'), rejected = count('rejected');
  const failedAll = total - okTotal;
  const overall = total >= 20 && failedAll > 0 ? ` Overall ${pct(failedAll / total)} of ${plural(total, 'request')} in the ${window} did not succeed.` : '';
  if (up >= 3 && up / n >= 0.2) {
    const causes = new Map();
    for (const r of recent) if (r.outcome === 'upstream_error' && r.cause) causes.set(r.cause, (causes.get(r.cause) || 0) + 1);
    const top = [...causes.entries()].sort((a, b) => b[1] - a[1])[0];
    add({
      id: 'reliability-provider-errors', severity: up / n >= 0.5 ? 'high' : 'medium', category: 'reliability',
      title: 'The model provider is returning errors',
      description: `${up} of your last ${plural(n, 'request')} failed upstream.${top ? ` Most common cause: ${top[0]}.` : ''}${overall}`,
      action: 'Retry in a few minutes. If it keeps happening, ask an admin to check the Vertex AI quota for the model.',
    });
  }
  if (capBlocked >= 1) {
    const lastBlock = Math.max(...recent.filter((r) => r.outcome === 'spend_cap').map((r) => Date.parse(r.ts) || 0));
    const fresh = !Number.isFinite(lastBlock) || lastBlock === 0 || now - lastBlock <= DAY;      // a block older than a day is history, not an alarm
    add({
      id: 'reliability-spend-cap', severity: fresh ? 'high' : 'medium', category: 'reliability',
      title: 'Requests were blocked by a spend limit',
      description: `${capBlocked} of your last ${plural(n, 'request')} in the ${window} were refused because a spend limit was reached.`,
      action: 'Ask an admin for a temporary boost, or wait for the budget period to reset.',
    });
  }
  if (rejected >= 3 && rejected / n >= 0.2) {
    add({
      id: 'reliability-rejected', severity: 'medium', category: 'reliability',
      title: 'Some requests were rejected',
      description: `${rejected} of your last ${plural(n, 'request')} were policy rejections: refused before a model was chosen, which usually means an expired sign-in or an unsupported request.`,
      action: 'Sign in again with the Claude Code client, and update it if it is out of date.',
    });
  }

  // ---- budget ----
  const live = overrides.filter((o) => o.status === 'active');
  for (const p of ['daily', 'weekly', 'monthly']) {
    const b = budgets[p];
    if (!b || b.capCents === null || b.capCents === undefined) continue;
    const spend = Number(b.spendCents) || 0, cap = Number(b.capCents);
    const zero = !(cap > 0);                                       // a $0 limit blocks every request, whatever has been spent
    const used = cap > 0 ? spend / cap : 1;
    const left = Math.max(0, cap - spend);
    const boost = live.find((o) => o.period === p);
    const boostNote = boost ? ` A temporary boost of ${usd(boost.extraCents)} is included until ${new Date(boost.endsAt).toISOString().slice(0, 10)}.` : '';
    if (used >= 1) {
      add({
        id: `budget-exhausted-${p}`, severity: 'high', category: 'budget',
        title: zero ? `Your ${PERIOD_LABEL[p]} budget is $0: you are blocked` : `Your ${PERIOD_LABEL[p]} budget is used up`,
        description: zero ? `The ${PERIOD_LABEL[p]} limit for you is ${usd(cap)}, so every request is blocked.${boostNote}` : `${usd(spend)} of ${usd(cap)} spent. New requests are blocked until the period resets.${boostNote}`,
        action: zero ? 'Ask an admin to set a budget for you.' : 'Ask an admin for a temporary boost if you need to keep working.',
      });
    } else if (used >= 0.8) {
      add({
        id: `budget-near-${p}`, severity: 'medium', category: 'budget',
        title: `Your ${PERIOD_LABEL[p]} budget is nearly used`,
        description: `${pct(used)} used: ${usd(spend)} of ${usd(cap)}, with ${usd(left)} left.${boostNote}`,
        action: 'Switch routine work to the default model, or ask an admin for a temporary boost.',
      });
    } else {
      add({
        id: `budget-ok-${p}`, severity: 'info', category: 'budget',
        title: `${PERIOD_LABEL[p][0].toUpperCase() + PERIOD_LABEL[p].slice(1)} budget on track`,
        description: `${pct(used)} used: ${usd(spend)} of ${usd(cap)}, with ${usd(left)} left.${boostNote}`,
      });
    }
    if (p === 'monthly' && used < 1 && !zero) {                    // pace only makes sense for a calendar month, and only once enough of it has passed
      const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      const elapsed = (now - start) / DAY, days = (end - start) / DAY;
      if (elapsed >= MIN_PACE_DAYS && spend > 0 && cap > 0) {
        const projected = Math.round((spend / elapsed) * days);
        const ratio = projected / cap;
        add({
          id: 'budget-pace-monthly', severity: ratio > 1.25 ? 'high' : ratio > 1 ? 'medium' : 'info', category: 'budget',
          title: ratio > 1 ? 'On pace to exceed your monthly budget' : 'Monthly pace looks fine',
          description: `${usd(spend)} spent in ${elapsed.toFixed(1)} of ${days} days (UTC). At this pace the month ends near ${usd(projected)}, against a ${usd(cap)} cap.`,
          action: ratio > 1 ? 'Slow down on the premium model or ask an admin to adjust the cap.' : null,
        });
      }
    }
  }
  if (['daily', 'weekly', 'monthly'].some((p) => budgets[p]?.unlimited)) {
    add({ id: 'budget-unlimited', severity: 'info', category: 'budget', title: 'No personal spend limit', description: 'An admin has removed the spend limit for you on at least one period, so you will not be blocked by budget.' });
  }

  // ---- telemetry (always) ----
  add({
    id: 'telemetry-unavailable', severity: 'info', category: 'telemetry',
    title: 'Token and prompt-cache tips are not available yet',
    description: 'Coaching on token usage and prompt caching needs telemetry from the Claude Code client, which this setup does not collect yet. The tips above come from your model mix, request outcomes and budgets only.',
  });

  const order = insights.map((i, k) => [i, k]).sort((a, b) => SEV[a[0].severity] - SEV[b[0].severity] || a[1] - b[1]).map(([i]) => i);
  const attention = order.filter((i) => i.severity !== 'info');
  let summary;
  if (attention.length) {
    const head = attention.slice(0, 2).map((i) => i.title.replace(/\.$/, '')).join('; ');
    summary = `${plural(attention.length, 'thing')} worth a look: ${head}${attention.length > 2 ? '; and more' : ''}.`;
  } else if (!total) {
    summary = `No requests in the ${window}, so there is not much to coach on yet.`;
  } else {
    summary = `Nothing urgent. ${plural(total, 'request')} in the ${window}${okTotal === total ? ', all successful' : ''}.`;
  }
  return { summary, insights: order };
}
