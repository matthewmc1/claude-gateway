// Temporary budget boosts: window maths, validation and presentation helpers. Pure.
import type { Override, OverrideStatus, Period } from './types.ts';
import type { Tone } from './budget.ts';
import { longSpan, oneLine, span, usd } from './format.ts';
import { parseDays, parseMoney } from './money.ts';

export type StartKind = 'now' | 'tomorrow' | 'monday';
export const START_OPTIONS: { value: StartKind; label: string }[] = [{ value: 'now', label: 'Now' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'monday', label: 'Next Monday' }];
export const DURATIONS: { key: string; days: number | null; label: string }[] = [
  { key: '1d', days: 1, label: '1 day' }, { key: '3d', days: 3, label: '3 days' }, { key: '1w', days: 7, label: '1 week' }, { key: '2w', days: 14, label: '2 weeks' }, { key: 'custom', days: null, label: 'Custom' },
];
export const EXTRA_PRESETS = [25, 50, 100];
export const REASON_CHIPS = ['On-call', 'Launch', 'Incident'];
export const REASON_MIN = 3, REASON_MAX = 200;
/** The server enforces its own maximum (`maxOverrideDays` from /api/health when it reports one, else 90). */
export const MAX_DAYS = 90, MAX_EXTRA_USD = 100000;
export const HOUR_MS = 3600_000, DAY_MS = 86400_000;
export const maxDaysOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : MAX_DAYS);

/** Local-time start of a boost. 'tomorrow' and 'monday' begin at local midnight. */
export function startOf(kind: StartKind, now: Date): Date {
  if (kind === 'now') return new Date(now.getTime());
  if (kind === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const ahead = (1 - now.getDay() + 7) % 7 || 7;      // next Monday, never today
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, 0, 0, 0, 0);
}
/** End = start plus whole local calendar days (so DST changes do not shift the wall-clock time), plus any fraction of a day in real time. */
export function endFrom(start: Date, days: number): Date {
  const whole = Math.floor(days), d = new Date(start.getTime());
  d.setDate(d.getDate() + whole);
  const frac = days - whole;
  return frac ? new Date(d.getTime() + Math.round(frac * DAY_MS)) : d;
}
export type Plan = { start: Date; end: Date; startsAt: string | undefined; endsAt: string; days: number; clamped: boolean };
/**
 * Window for a boost. The end is calendar-day based, but the server limits the REAL duration, and a 90 calendar-day window that
 * crosses a clock change is 2161 hours (> 90 x 24). So the end is clamped to the server maximum less a safety hour.
 */
export function planWindow(kind: StartKind, days: number, now: Date, maxDays?: number): Plan {
  const start = startOf(kind, now);
  let end = endFrom(start, days), clamped = false;
  const limit = maxDaysOf(maxDays) * DAY_MS;
  if (end.getTime() - start.getTime() > limit) { end = new Date(start.getTime() + limit - HOUR_MS); clamped = true; }
  return { start, end, startsAt: kind === 'now' ? undefined : start.toISOString(), endsAt: end.toISOString(), days, clamped };
}

/** Parse a user-typed amount of dollars into integer cents, or null when blank or invalid (see parseMoney for the reason). */
export function parseAmountCents(text: string): number | null {
  const p = parseMoney(text, { max: MAX_EXTRA_USD, allowZero: false });
  return p.ok ? p.cents : null;
}
/** Kept for callers that want dollars: the amount as a number, from exact cents. */
export function parseAmount(text: string): number | null {
  const c = parseAmountCents(text);
  return c === null ? null : c / 100;
}
export { parseDays, parseMoney };

export type BoostInput = { extraCents: number | null; days: number | null; reason: string; capCents: number | null; unlimited: boolean; maxDays?: number };
/** First problem with the form, or null when it can be submitted. */
export function boostError(i: BoostInput): string | null {
  if (i.unlimited) return 'This period is unlimited, so there is no cap to extend.';
  if (i.capCents === null) return 'There is no cap on this period, so there is nothing to extend. Set a budget first.';
  if (i.extraCents === null) return 'Enter the extra amount in dollars.';
  if (i.extraCents <= 0) return 'The extra amount must be more than $0.';
  if (i.extraCents > MAX_EXTRA_USD * 100) return `The extra amount cannot exceed ${usd(MAX_EXTRA_USD * 100)}.`;
  if (i.days === null) return 'Enter how many days the boost lasts.';
  if (i.days < 1 / 24) return 'A boost lasts at least one hour.';
  const maxDays = maxDaysOf(i.maxDays);
  if (i.days > maxDays) return `A boost cannot last more than ${maxDays} days.`;
  const r = oneLine(i.reason);
  if (r.length < REASON_MIN) return `Add a reason (at least ${REASON_MIN} characters).`;
  if (r.length > REASON_MAX) return `The reason is too long (${r.length}/${REASON_MAX}).`;
  return null;
}
export const capAfter = (capCents: number | null, extraCents: number): number | null => (capCents === null ? null : capCents + extraCents);

/** Reason chips write "Chip: free text"; this finds the chip a reason currently starts with. */
export function reasonChip(text: string): string | null {
  return REASON_CHIPS.find((c) => text === c || text.startsWith(c + ': ')) ?? null;
}
export function applyReasonChip(text: string, chip: string): string {
  const cur = reasonChip(text);
  const rest = cur ? text.slice(cur.length).replace(/^:\s*/, '') : text.trim();
  if (cur === chip) return rest;               // toggle off
  return rest ? `${chip}: ${rest}` : chip;
}

export const isLive = (o: Pick<Override, 'status'>) => o.status === 'scheduled' || o.status === 'active';
export const STATUS: Record<OverrideStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' }, scheduled: { label: 'Scheduled', tone: 'accent' }, ended: { label: 'Ended', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' }, superseded: { label: 'Superseded', tone: 'warn' }, failed: { label: 'Failed', tone: 'crit' },
};
export const statusInfo = (s: string) => STATUS[s as OverrideStatus] ?? { label: s, tone: 'muted' as Tone };

/** The scheduler runs about once a minute, so a boost a little past its time is normal; beyond this it is a real problem. */
export const GRACE_MS = 2 * 60_000;
type Timed = Pick<Override, 'status' | 'startsAt' | 'endsAt'> & Partial<Pick<Override, 'overdue' | 'overdueMs'>>;
/**
 * How long an ACTIVE boost has been past its end without the cap being restored (ms), or null when it is not overdue.
 * Uses the server's `overdue` / `overdueMs` when it sends them, otherwise computes from endsAt. The server's figure is a snapshot,
 * so the larger of it and the locally computed one is shown.
 */
export function overdueMs(o: Timed, now: number = Date.now()): number | null {
  if (o.status !== 'active') return null;
  const end = Date.parse(o.endsAt), local = Number.isFinite(end) ? now - end : null;
  if (typeof o.overdue === 'boolean') {
    if (!o.overdue) return null;
    const srv = typeof o.overdueMs === 'number' && Number.isFinite(o.overdueMs) ? Math.max(0, o.overdueMs) : 0;
    return Math.max(srv, local ?? 0, 0);
  }
  return local !== null && local >= 0 ? local : null;
}
/** How late a SCHEDULED boost is to start (ms), or null when it is not late. */
export function startLateMs(o: Timed, now: number = Date.now()): number | null {
  if (o.status !== 'scheduled') return null;
  const late = now - Date.parse(o.startsAt);
  return Number.isFinite(late) && late >= GRACE_MS ? late : null;
}
export const overdueText = (ms: number) => ms < GRACE_MS
  ? 'Ended just now: the scheduler is restoring the cap.'
  : `Overdue by ${longSpan(ms)}: the cap has not been restored yet, check the scheduler.`;

/** Label and tone for a boost's chip. An active boost past its end is a warning, never a green "Active". */
export function statusDisplay(o: Timed, now: number = Date.now()): { label: string; tone: Tone } {
  const od = overdueMs(o, now);
  if (od !== null) return od < GRACE_MS ? { label: 'Ending', tone: 'warn' } : { label: 'Overdue', tone: od >= 30 * 60_000 ? 'crit' : 'serious' };
  if (startLateMs(o, now) !== null) return { label: 'Late to start', tone: 'warn' };
  return statusInfo(o.status);
}

/** "2d 4h left", "starts in 3h", an overdue sentence, or null for finished boosts. */
export function remaining(o: Timed, now: number = Date.now()): string | null {
  if (o.status === 'active') { const od = overdueMs(o, now); return od !== null ? overdueText(od) : `${span(new Date(o.endsAt).getTime() - now)} left`; }
  if (o.status === 'scheduled') {
    const late = startLateMs(o, now);
    return late !== null ? `Should have started ${longSpan(late)} ago: waiting for the scheduler.` : `starts in ${span(new Date(o.startsAt).getTime() - now)}`;
  }
  return null;
}
export function summarize(list: Pick<Override, 'status'>[]): { active: number; scheduled: number } {
  return { active: list.filter((o) => o.status === 'active').length, scheduled: list.filter((o) => o.status === 'scheduled').length };
}
/** The override to badge on a person's card: active ones first, then the soonest scheduled one. */
export function primaryOverride<T extends Pick<Override, 'status' | 'startsAt'>>(list: T[] | undefined): { o: T; more: number } | null {
  const live = (list ?? []).filter(isLive);
  if (!live.length) return null;
  const sorted = [...live].sort((a, b) => (a.status === b.status ? new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() : a.status === 'active' ? -1 : 1));
  return { o: sorted[0], more: sorted.length - 1 };
}
export const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const periodWord = (p: Period) => (p === 'weekly' ? 'weekly' : 'monthly');
export function badgeText(o: Pick<Override, 'status' | 'startsAt' | 'endsAt' | 'extraCents'> & Partial<Pick<Override, 'overdue' | 'overdueMs' | 'period'>>, now: number = Date.now(), showPeriod = false): string {
  const extra = usd(o.extraCents, { signed: true }) + (showPeriod && o.period ? ` ${o.period}` : '');
  const od = overdueMs(o, now);
  if (od !== null && od >= GRACE_MS) return `Boost ${extra} overdue by ${longSpan(od)}`;
  return o.status === 'active' ? `Boost ${extra} until ${shortDay(o.endsAt)}` : `Boost ${extra} from ${shortDay(o.startsAt)}`;
}

/** The first live boost on the same period whose window overlaps [start, end), if any (the server answers 409 for these). */
export function findOverlap<T extends Pick<Override, 'status' | 'period' | 'startsAt' | 'endsAt'>>(list: T[], period: Period, start: Date, end: Date): T | null {
  return list.find((o) => isLive(o) && o.period === period && new Date(o.startsAt).getTime() < end.getTime() && new Date(o.endsAt).getTime() > start.getTime()) ?? null;
}

// ---- M3: a boost must never hide itself ----
type CapView = { capCents: number | null; source: string | null; unlimited: boolean };
/** The active boost whose boosted cap IS this person's personal cap right now (so the cap shown includes it), if any. */
export function includedBoost<T extends Pick<Override, 'status' | 'period' | 'targetCents'>>(budget: CapView | undefined, overrides: T[] | undefined, period: Period): T | null {
  if (!budget || budget.unlimited || budget.capCents === null || budget.source !== 'user') return null;
  return (overrides ?? []).find((o) => o.status === 'active' && o.period === period && o.targetCents !== null && o.targetCents === budget.capCents) ?? null;
}
/** "Includes +$50 boost until Fri, Oct 16 (base $200)". */
export function includesText(o: Pick<Override, 'status' | 'extraCents' | 'endsAt' | 'baseCents'> & Partial<Pick<Override, 'overdue' | 'overdueMs'>>, now: number = Date.now()): string {
  const extra = usd(o.extraCents, { signed: true }), base = o.baseCents !== null && o.baseCents !== undefined ? ` (base ${usd(o.baseCents)})` : '';
  const od = overdueMs(o as any, now);
  return od !== null && od >= GRACE_MS ? `Includes ${extra} boost that should have ended ${longSpan(od)} ago${base}` : `Includes ${extra} boost until ${shortDay(o.endsAt)}${base}`;
}
/** What saving a change over a live boost does, in words the admin can act on. */
export function supersedeText(o: Pick<Override, 'extraCents' | 'endsAt'>): string {
  return `A live ${usd(o.extraCents, { signed: true })} boost (until ${shortDay(o.endsAt)}) is part of this cap. Saving replaces the boosted cap right away, so the boost stops having any effect and, when its window ends, nothing is restored: it will show as superseded and the cap you save stays. Cancel the boost first if you want the previous limit back before changing it.`;
}

// ---- M4 / M5: say what actually happened ----
export type Outcome = { text: string; kind: 'ok' | 'warn' };
const stripRetry = (n: string) => n.replace(/^will retry:?\s*/i, '');
const noteOf = (o: { note?: string | null } | null | undefined) => (o?.note ? oneLine(o.note) : '');
const dot = (s: string) => { const t = s.charAt(0).toUpperCase() + s.slice(1); return /[.!?]$/.test(t) ? t : t + '.'; };
/** The toast after creating a boost, built from the status and note the server RETURNED rather than assumed. */
export function grantOutcome(o: Pick<Override, 'status' | 'startsAt'> & { note?: string | null } | null | undefined, ctx: { name: string; period: Period; extraCents: number; now?: number }): Outcome {
  const now = ctx.now ?? Date.now(), what = `${usd(ctx.extraCents, { signed: true })} ${ctx.period} for ${oneLine(ctx.name)}`;
  const note = noteOf(o);
  if (!o || !o.status) return { text: `Boost request sent for ${what}. Check its status below.`, kind: 'warn' };
  if (o.status === 'failed') return { text: `Boost could not be applied: ${note || 'the gateway refused the change'}`, kind: 'warn' };
  if (o.status === 'scheduled') {
    const due = Date.parse(o.startsAt) <= now + GRACE_MS;
    if (due && note) return { text: `Could not apply yet: will retry. ${dot(stripRetry(note))}`, kind: 'warn' };
    return { text: `Boost scheduled: ${what} from ${shortDay(o.startsAt)}.${note ? ' ' + dot(note) : ''}`, kind: note ? 'warn' : 'ok' };
  }
  if (o.status === 'active') return { text: `Boost active: ${what}.${note ? ' ' + dot(note) : ''}`, kind: note ? 'warn' : 'ok' };
  return { text: `Boost is ${o.status}.${note ? ' ' + dot(note) : ''}`, kind: 'warn' };
}
/** The toast after cancelling. Claims the cap was restored only when the boost had been applied and the server added no caveat. */
export function cancelOutcome(before: string, o: ({ status?: string; note?: string | null }) | null | undefined): Outcome {
  const note = noteOf(o);
  if (note) return { text: `${o?.status === 'cancelled' || !o?.status ? 'Cancelled' : 'Boost ' + o.status}. ${dot(note)}`, kind: 'warn' };
  if (o?.status && o.status !== 'cancelled') return { text: `Boost is now ${o.status}.`, kind: 'warn' };
  return before === 'active' ? { text: 'Boost cancelled. The previous limit was restored.', kind: 'ok' } : { text: 'Scheduled boost cancelled. The cap was never changed.', kind: 'ok' };
}
export function retryOutcome(o: Pick<Override, 'status'> & { note?: string | null } | null | undefined): Outcome {
  const note = noteOf(o);
  if (o?.status === 'active') return { text: `Boost applied.${note ? ' ' + dot(note) : ''}`, kind: note ? 'warn' : 'ok' };
  if (o?.status === 'scheduled') return { text: `Boost is scheduled again.${note ? ' ' + dot(stripRetry(note)) : ''}`, kind: note ? 'warn' : 'ok' };
  return { text: `Still could not apply the boost${note ? ': ' + note : '.'}`, kind: 'warn' };
}
/** A failed boost can only be retried while its window has not already ended. */
export const canRetry = (o: Pick<Override, 'status' | 'endsAt'>, now: number = Date.now()) => o.status === 'failed' && Date.parse(o.endsAt) > now;
