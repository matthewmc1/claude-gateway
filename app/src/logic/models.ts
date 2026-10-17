import type { ModelInfo, PriceHint } from './types.ts';
import type { Tone } from './budget.ts';

export const TIER: Record<string, { label: string; tone: Tone }> = {
  default: { label: 'Default', tone: 'accent' }, upgrade: { label: 'Upgrade', tone: 'warn' }, fast: { label: 'Fast', tone: 'good' }, previous: { label: 'Previous', tone: 'muted' },
};
export const tierInfo = (t: string) => TIER[t] ?? { label: t, tone: 'muted' as Tone };

/** A usage row names the model the gateway saw; it may carry a date suffix, so match the configured id as a prefix too. */
export function matchModel(usageModel: string, models: Pick<ModelInfo, 'id'>[]): string | null {
  const exact = models.find((m) => m.id === usageModel);
  if (exact) return exact.id;
  return models.find((m) => usageModel.startsWith(m.id + '-') || usageModel.startsWith(m.id + '@'))?.id ?? null;
}
export type Share = { requests: number; ok: number; share: number };
export function usageShares(models: Pick<ModelInfo, 'id'>[], usage: { model: string; requests: number; ok: number }[]) {
  const total = usage.reduce((s, u) => s + u.requests, 0);
  const by = new Map<string, Share>(models.map((m) => [m.id, { requests: 0, ok: 0, share: 0 }]));
  const other: { model: string; requests: number; ok: number; share: number }[] = [];
  for (const u of usage) {
    const id = matchModel(u.model, models);
    const share = total ? u.requests / total : 0;
    if (id) { const s = by.get(id)!; s.requests += u.requests; s.ok += u.ok; s.share += share; }
    else other.push({ ...u, share });
  }
  return { total, by, other };
}
const money = (n: number) => '$' + (Number.isInteger(n) ? n : n.toFixed(2));
/** "$3 in · $15 out per 1M tokens"; null when the operator has not set prices (never show made-up numbers). */
export function priceHint(p: PriceHint | null | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.input != null) parts.push(`${money(p.input)} in`);
  if (p.output != null) parts.push(`${money(p.output)} out`);
  if (p.cacheRead != null) parts.push(`${money(p.cacheRead)} cache read`);
  if (p.cacheWrite != null) parts.push(`${money(p.cacheWrite)} cache write`);
  return parts.length ? parts.join(' · ') + ' per 1M tokens' : null;
}

/** Defence in depth: the API already refuses a bad catalog, but this page must never show a contradictory one as if it were fine. */
export function catalogProblems(models: Pick<ModelInfo, 'alias' | 'id' | 'enabled' | 'family' | 'pinned'>[], def: string): string[] {
  const out: string[] = [];
  const dup = (vals: string[]) => vals.filter((v, i) => vals.indexOf(v) !== i);
  const aliases = dup(models.map((m) => m.alias.toLowerCase())), ids = dup(models.map((m) => m.id));
  if (aliases.length) out.push(`Model aliases must be unique (${[...new Set(aliases)].join(', ')}).`);
  if (ids.length) out.push(`Model ids must be unique (${[...new Set(ids)].join(', ')}).`);
  const byFamily = new Map<string, string[]>();
  for (const m of models) if (m.pinned && m.family) byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m.alias]);
  for (const [f, names] of byFamily) if (names.length > 1) out.push(`More than one model pins the ${f} family (${names.join(', ')}); only one may.`);
  for (const m of models) if (m.pinned && !m.enabled) out.push(`${m.alias} is pinned but disabled.`);
  const d = models.find((m) => m.alias === def);
  if (!d) out.push(`The default model "${def}" is not in the list.`); else if (!d.enabled) out.push(`The default model "${def}" is disabled.`);
  return out;
}

/** What each entry is to engineers: the starting model, the one a family alias means ("pinned"), or an extra they pick by name. */
export function modelRole(m: Pick<ModelInfo, 'alias' | 'enabled' | 'family' | 'pinned'>, def: string): 'default' | 'pinned' | 'extra' | 'off' {
  if (!m.enabled) return 'off';
  if (m.alias === def) return 'default';
  return m.pinned ? 'pinned' : 'extra';
}

/**
 * How to make the "previous" generation (tier "previous", e.g. Claude 4.6) the default for everyone: the edits to config/models.json,
 * or null when there is nothing to switch to (no previous entries, or they already are the pinned ones).
 * `tiers` swaps the tier labels with the pins (the new model takes the tier of the one it replaces; the replaced one becomes "previous"),
 * so the cards, `upgrade` and the descriptions keep describing the real state.
 */
export type Recipe = { defaultAlias: string; edits: { alias: string; pin: boolean }[]; tiers: { alias: string; tier: string }[] };
export function previousRecipe(models: Pick<ModelInfo, 'alias' | 'tier' | 'enabled' | 'family' | 'pinned'>[], def: string): Recipe | null {
  const prev = models.filter((m) => m.tier === 'previous' && m.enabled && m.family && !m.pinned);
  if (!prev.length) return null;
  const edits: Recipe['edits'] = [], tiers: Recipe['tiers'] = [];
  for (const p of prev) {
    const cur = models.find((m) => m.pinned && m.family === p.family && m.enabled);
    edits.push({ alias: p.alias, pin: true });
    if (cur) { edits.push({ alias: cur.alias, pin: false }); if (cur.tier !== 'previous') { tiers.push({ alias: p.alias, tier: cur.tier }, { alias: cur.alias, tier: 'previous' }); } }
  }
  const defFamily = models.find((m) => m.alias === def)?.family;
  const first = prev.find((p) => p.family === defFamily) ?? prev.find((p) => p.family === 'sonnet') ?? prev[0];
  return { defaultAlias: first.alias, edits, tiers };
}

/**
 * Families that have an enabled entry but no pinned one: `/model sonnet` would then mean Claude Code's own version, which may not be
 * on the allowed list (a 400). The API sends the same warnings; this is the fallback for an older backend.
 */
export function unpinnedFamilyWarnings(models: Pick<ModelInfo, 'alias' | 'enabled' | 'family' | 'pinned'>[]): string[] {
  const out: string[] = [];
  for (const f of ['sonnet', 'opus', 'haiku']) {
    const mem = models.filter((m) => m.enabled && m.family === f);
    if (mem.length && !mem.some((m) => m.pinned)) out.push(`No enabled model pins the ${f} family (${mem.map((m) => m.alias).join(', ')}), so /model ${f} is not set for anyone and may be refused. Set "pin": true on one ${f} entry.`);
  }
  return out;
}
