import type { ModelInfo, PriceHint } from './types.ts';
import type { Tone } from './budget.ts';

export const TIER: Record<string, { label: string; tone: Tone }> = {
  default: { label: 'Default', tone: 'accent' }, upgrade: { label: 'Upgrade', tone: 'warn' }, fast: { label: 'Fast', tone: 'good' },
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
