// Pure formatting helpers (no react-native imports).
export function usd(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  // Integer cents all the way: no float division, so '$1,000.50' never loses a digit and 0.1 + 0.2 style drift cannot appear.
  const c = Math.round(cents), abs = Math.abs(c);
  const dollars = Math.floor(abs / 100), rest = abs % 100;
  const body = '$' + dollars.toLocaleString('en-US') + (rest ? '.' + String(rest).padStart(2, '0') : '');
  return (opts.signed && c > 0 ? '+' : c < 0 ? '−' : '') + body;
}
/** Null-safe: a missing or non-finite number reads as an em dash, never a crash or "NaN". */
export const int = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export const clock = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dayTime = (d: Date | string) => new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function bucketLabel(iso: string, seconds: number) {
  const d = new Date(iso);
  return seconds >= 86400 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric' });
}
/** First user-perceived character (grapheme) of a string: never splits an emoji or surrogate pair. */
export function firstGlyph(s: string): string {
  const Seg = (Intl as any).Segmenter;
  if (typeof Seg === 'function') { for (const x of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) return x.segment as string; return ''; }
  return Array.from(s)[0] ?? '';
}
/** Up to two initials from a name or email. Empty when there is nothing to show (callers draw a neutral glyph, not "?"). */
export const initials = (name: string | null | undefined) => plain(name ?? '').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => firstGlyph(p).toUpperCase()).join('');
export const modelShort = (m: string) => m.replace(/^claude-/, '').replace(/-2025\d{4}$/, '');
export const pct = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—');
/** Share of a cap used, for display: never rounds 99.6% up to "100% used" (only a real 100% or more reads 100). */
export const pctUsed = (n: number | null | undefined) => `${pctUsedNum(n)}%`;
export const pctUsedNum = (n: number | null | undefined) => (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 ? 0 : n >= 1 ? Math.round(n * 100) : Math.min(99, Math.round(n * 100)));
/** "2d 4h", "3h 20m", "12m", "<1m". Two most significant units. */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60000);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}
/** Plural helper: plural(1,'day') = '1 day', plural(3,'day') = '3 days'. */
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "2 h", "2 d 4 h", "12 min": a spaced, spelled-out duration for sentences. */
export function longSpan(ms: number): string {
  const m = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60000);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return mm && h < 6 ? `${h} h ${mm} min` : `${h} h`;
  return `${mm} min`;
}

// Display safety: people-supplied text (names, reasons, notes) is rendered as plain text. React never interprets it as markup,
// but bidirectional overrides and control characters can still reorder or hide what a reader sees, so they are removed.
const INVISIBLE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b\\u200c\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]|[\\u{e0000}-\\u{e007f}]', 'gu');   // U+200D (zero-width joiner) is kept: emoji sequences need it
/** Strip bidi override/isolate marks, zero-width characters and control characters. Newlines and tabs survive. */
export const plain = (s: string): string => s.replace(INVISIBLE, '');
/** plain() plus whitespace collapsed to single spaces: for names, reasons and notes shown inline. */
export const oneLine = (s: string): string => plain(s).replace(/\s+/g, ' ').trim();
