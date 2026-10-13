// Defensive clean-up at the API edge: one malformed number (null where a number is expected) must not blank the whole app.
import type { Budget, Budgets } from './types.ts';
export const finite = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);
const capOf = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
export function cleanBudget(b: Partial<Budget> | null | undefined): Budget {
  return { capCents: capOf(b?.capCents), spendCents: Math.max(0, finite(b?.spendCents)), source: b?.source ?? null, limitId: b?.limitId ?? null, unlimited: !!b?.unlimited };
}
export function cleanBudgets(b: Partial<Budgets> | null | undefined): Budgets {
  return { daily: cleanBudget(b?.daily), weekly: cleanBudget(b?.weekly), monthly: cleanBudget(b?.monthly) };
}
/** A list that might be missing or not a list. */
export const list = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
export const cleanSpend = (s: { spendCents?: unknown; committedCents?: unknown; uncappedUsers?: unknown } | null | undefined) => ({ spendCents: finite(s?.spendCents), committedCents: finite(s?.committedCents), uncappedUsers: finite(s?.uncappedUsers) });
