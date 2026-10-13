// What a change to the company default does to people who rely on it. Pure, integer cents.
import type { Budget, Period } from './types.ts';

export type PersonCaps = {
  budgets: Record<'daily' | 'weekly' | 'monthly', Pick<Budget, 'capCents' | 'spendCents' | 'source' | 'unlimited'>>;
  overrides?: { status: string; period: string; prev?: { kind: string } | null }[];
};
/** A personal cap (or personal "unlimited") means the company default does not apply to that person. */
export const hasPersonalCap = (b: Pick<Budget, 'source' | 'unlimited'>) => b.source === 'user' || b.unlimited;
/** People with a personal cap or personal unlimited on any period (people, not limit rows). */
export const peopleWithPersonalCaps = (people: PersonCaps[]) => people.filter((p) => (['daily', 'weekly', 'monthly'] as const).some((k) => hasPersonalCap(p.budgets[k]))).length;

/** People whose live boost in this period was built on the company default, so a new default re-bases it. */
export function rebasedBoosts(people: PersonCaps[], period: Period): number {
  return people.filter((p) => (p.overrides ?? []).some((o) => o.period === period && ((o.status === 'active' && o.prev?.kind === 'none') || (o.status === 'scheduled' && !hasPersonalCap(p.budgets[period]))))).length;
}

export type OrgImpact = {
  rebased: number;                 // people with a live boost that will be re-based on the new default
  relying: number;                 // people who get the company default (no personal cap)
  newlyBlocked: number;            // of them, people who are not blocked now but would be (spend >= new cap)
  allBlocked: boolean;             // the new cap is $0: every one of them
  exposureBefore: number | null;   // max possible spend per period across `relying` people at the old cap; null = unbounded
  exposureAfter: number | null;
  needsConfirm: boolean;
  lines: string[];
};
const usdC = (c: number) => '$' + (Math.floor(c / 100)).toLocaleString('en-US') + (c % 100 ? '.' + String(c % 100).padStart(2, '0') : '');
const peopleWord = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

export function orgImpact(people: PersonCaps[] | null | undefined, period: Period, curCents: number | null, nextCents: number | null): OrgImpact {
  const decrease = nextCents === 0 || (nextCents !== null && curCents !== null && nextCents < curCents);
  const removal = nextCents === null && curCents !== null;
  if (!people) {
    return { rebased: 0, relying: 0, newlyBlocked: 0, allBlocked: nextCents === 0, exposureBefore: null, exposureAfter: null, needsConfirm: decrease || removal || (nextCents !== null && curCents === null),
      lines: [nextCents === 0 ? 'A $0 default blocks everyone who has no personal cap.' : 'Could not load the list of people, so the effect on them cannot be shown.'] };
  }
  const relying = people.filter((p) => !hasPersonalCap(p.budgets[period]));
  const n = relying.length;
  const wasBlocked = (spend: number) => curCents !== null && spend >= curCents;
  const newlyBlocked = nextCents === null ? 0 : relying.filter((p) => p.budgets[period].spendCents >= nextCents && !wasBlocked(p.budgets[period].spendCents)).length;
  const exposureBefore = curCents === null ? null : curCents * n, exposureAfter = nextCents === null ? null : nextCents * n;
  const lines: string[] = [];
  if (nextCents === 0) lines.push(n ? `This blocks ${n === 1 ? 'the 1 person' : 'all ' + n + ' people'} who ${n === 1 ? 'has' : 'have'} no personal cap.` : 'A $0 default blocks everyone who has no personal cap. Nobody relies on the default right now.');
  else if (newlyBlocked) lines.push(`This blocks ${newlyBlocked} of ${peopleWord(n)} with no personal cap right away: they have already spent at least ${usdC(nextCents!)} this ${period === 'weekly' ? 'week' : 'month'}.`);
  if (removal) lines.push(n ? `Removing the default leaves ${peopleWord(n)} with no cap at all, so their spend is unlimited.` : 'Removing the default leaves anyone without a personal cap unlimited.');
  if (nextCents !== null && curCents === null && n) lines.push(`${peopleWord(n)} with no cap today would be capped at ${usdC(nextCents)} each.`);
  if (nextCents !== null && curCents !== null && n && nextCents !== curCents) {
    const d = (nextCents - curCents) * n;
    lines.push(`Most these ${peopleWord(n)} could spend per ${period === 'weekly' ? 'week' : 'month'}: ${usdC(exposureBefore!)} to ${usdC(exposureAfter!)} (${d > 0 ? '+' : '−'}${usdC(Math.abs(d))}).`);
  }
  const rebased = curCents === nextCents ? 0 : rebasedBoosts(people, period);
  if (rebased) lines.push(`${rebased} ${rebased === 1 ? 'person' : 'people'} with a live boost will have their boost re-based on the new default.`);
  return { rebased, relying: n, newlyBlocked, allBlocked: nextCents === 0, exposureBefore, exposureAfter, needsConfirm: decrease || removal || newlyBlocked > 0 || rebased > 0, lines };
}
