import { Theme } from './theme';
export const outcomeInfo = (t: Theme, o: string) => ({
  ok: { label: 'OK', color: t.good }, rejected: { label: 'Rejected', color: t.warn },
  spend_cap: { label: 'Spend cap', color: t.serious }, upstream_error: { label: 'Provider error', color: t.crit },
} as Record<string, { label: string; color: string }>)[o] || { label: o, color: t.muted };
