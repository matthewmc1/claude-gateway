export type Tone = 'good' | 'warn' | 'serious' | 'crit' | 'accent' | 'muted';
export type BudgetKey = 'nocap' | 'ok' | 'watch' | 'near' | 'over' | 'unlimited';
export type BudgetState = { key: BudgetKey; label: string; tone: Tone; pct: number };

/** Budget state is always paired with a text label so colour is never the only signal. */
export function budgetState(spendRaw: number | null | undefined, capRaw: number | null | undefined, unlimited = false): BudgetState {
  // A malformed number from the API (null, NaN) must not crash a page: spend reads as 0, a bad cap as no cap.
  const spendCents = typeof spendRaw === 'number' && Number.isFinite(spendRaw) ? spendRaw : 0;
  const capCents = typeof capRaw === 'number' && Number.isFinite(capRaw) ? capRaw : null;
  if (unlimited) return { key: 'unlimited', label: 'Unlimited', tone: 'accent', pct: 0 };
  if (capCents === null) return { key: 'nocap', label: 'No cap', tone: 'muted', pct: 0 };
  if (capCents === 0) return { key: 'over', label: 'Blocked', tone: 'crit', pct: 1 };
  const pct = spendCents / capCents;
  if (pct >= 1) return { key: 'over', label: 'At limit', tone: 'crit', pct };
  if (pct >= 0.85) return { key: 'near', label: 'Near limit', tone: 'serious', pct };
  if (pct >= 0.6) return { key: 'watch', label: 'Watch', tone: 'warn', pct };
  return { key: 'ok', label: 'On track', tone: 'good', pct };
}
