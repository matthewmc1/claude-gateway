// Coach presentation logic. The insights themselves come from the backend; this only orders and labels them.
import type { Insight, Severity } from './types.ts';
import type { Tone } from './budget.ts';

const RANK: Record<string, number> = { high: 0, medium: 1, info: 2 };
export const isTelemetry = (i: Pick<Insight, 'category'>) => i.category === 'telemetry';
/** Highest severity first; the telemetry note always last; otherwise the backend's order is kept. */
export function orderInsights(list: Insight[]): Insight[] {
  return list.map((x, idx) => ({ x, idx }))
    .sort((a, b) => Number(isTelemetry(a.x)) - Number(isTelemetry(b.x)) || (RANK[a.x.severity] ?? 3) - (RANK[b.x.severity] ?? 3) || a.idx - b.idx)
    .map((e) => e.x);
}
export const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
  high: { label: 'High priority', tone: 'serious' }, medium: { label: 'Worth a look', tone: 'warn' }, info: { label: 'Good to know', tone: 'accent' },
};
export const severityInfo = (s: string) => SEVERITY[s as Severity] ?? SEVERITY.info;
export const CATEGORY: Record<string, string> = { model: 'Model choice', reliability: 'Reliability', budget: 'Budget', telemetry: 'Telemetry' };
export const categoryLabel = (c: string) => CATEGORY[c] ?? c;
export const countBySeverity = (list: Insight[]) => ({
  high: list.filter((i) => i.severity === 'high').length, medium: list.filter((i) => i.severity === 'medium').length,
});

/** The backend's `action` is a shell/session command for some tips and a plain sentence for others. Only commands get a Copy box. */
export function isCommand(action: string | null | undefined): boolean {
  if (!action) return false;
  const a = action.trim();
  if (/^\/(model|effort|clear|compact|config)\b/.test(a)) return true;       // in-session slash command
  return /^(\.\/|~\/|\/)?[\w./-]*claude-gateway-setup\.sh(\s|$)/.test(a) || /^(\$ )?(terraform|gcloud|git|npm|npx|bash|sh)\s/.test(a);
}
