export function usd(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (cents === null || cents === undefined) return '—';
  const v = cents / 100;
  const abs = Math.abs(v);
  const s = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(abs) || abs >= 1000 ? 0 : 2, maximumFractionDigits: 2 });
  return (opts.signed && v > 0 ? '+' : v < 0 ? '−' : '') + s;
}
export const int = (n: number) => n.toLocaleString('en-US');
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export const clock = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function bucketLabel(iso: string, seconds: number) {
  const d = new Date(iso);
  return seconds >= 86400 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric' });
}
export const initials = (name: string) => name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
export const modelShort = (m: string) => m.replace(/^claude-/, '').replace(/-2025\d{4}$/, '');
export const pct = (n: number) => `${Math.round(n * 100)}%`;
