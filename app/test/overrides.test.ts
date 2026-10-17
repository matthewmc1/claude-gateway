import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasonChip, badgeText, boostError, capAfter, endFrom, isLive, parseAmount, planWindow, primaryOverride, reasonChip, remaining, startOf, statusInfo, summarize } from '../src/logic/overrides.ts';

const TUE = new Date(2026, 9, 13, 10, 42);      // Tue 13 Oct 2026, local time

test('start options', () => {
  assert.equal(startOf('now', TUE).getTime(), TUE.getTime());
  const tm = startOf('tomorrow', TUE);
  assert.deepEqual([tm.getFullYear(), tm.getMonth(), tm.getDate(), tm.getHours(), tm.getMinutes()], [2026, 9, 14, 0, 0]);
  const mon = startOf('monday', TUE);
  assert.deepEqual([mon.getDate(), mon.getDay(), mon.getHours()], [19, 1, 0]);
});
test('next Monday is never today and rolls across month ends', () => {
  const monday = new Date(2026, 9, 12, 9, 0);
  assert.equal(startOf('monday', monday).getDate(), 19);
  const sun = new Date(2026, 9, 18, 9, 0);
  assert.equal(startOf('monday', sun).getDate(), 19);
  const lateOct = new Date(2026, 9, 29, 9, 0);      // Thursday
  const m = startOf('monday', lateOct);
  assert.deepEqual([m.getMonth(), m.getDate()], [10, 2]);
});
test('window ends N calendar days after the start', () => {
  const p = planWindow('now', 3, TUE);
  assert.equal(p.startsAt, undefined);
  assert.equal(p.end.getDate(), 16);
  assert.equal(p.end.getHours(), 10);
  assert.equal(p.days, 3);
  const q = planWindow('tomorrow', 7, TUE);
  assert.equal(q.startsAt, q.start.toISOString());
  assert.equal(q.end.getDate(), 21);
  assert.ok(q.end > q.start);
  assert.equal(endFrom(TUE, 1.5).getTime() - TUE.getTime(), 36 * 3600_000);
});
test('parseAmount', () => {
  assert.equal(parseAmount('50'), 50);
  assert.equal(parseAmount(' 12.5 '), 12.5);
  for (const bad of ['', 'abc', '-5', '0', '1e3', '0x10', '1.234', '٥٠']) assert.equal(parseAmount(bad), null, bad);
});
test('boostError rules', () => {
  const ok = { extraCents: 5000, days: 3, reason: 'On-call', capCents: 20000, unlimited: false };
  assert.equal(boostError(ok), null);
  assert.match(boostError({ ...ok, unlimited: true })!, /unlimited/);
  assert.match(boostError({ ...ok, capCents: null })!, /no cap/i);
  assert.match(boostError({ ...ok, extraCents: null })!, /extra amount/);
  assert.match(boostError({ ...ok, days: null })!, /days/);
  assert.match(boostError({ ...ok, days: 0.01 })!, /one hour/);
  assert.match(boostError({ ...ok, days: 400 })!, /more than/);
  assert.match(boostError({ ...ok, reason: 'ab' })!, /reason/);
  assert.match(boostError({ ...ok, reason: '  a ' })!, /reason/);
  assert.match(boostError({ ...ok, reason: 'x'.repeat(201) })!, /too long/);
  assert.equal(boostError({ ...ok, reason: 'x'.repeat(200) }), null);
});
test('capAfter', () => {
  assert.equal(capAfter(20000, 5000), 25000);
  assert.equal(capAfter(null, 5000), null);
  assert.equal(capAfter(20000, 1250), 21250);
});
test('reason chips toggle and keep free text', () => {
  assert.equal(applyReasonChip('', 'On-call'), 'On-call');
  assert.equal(applyReasonChip('On-call', 'On-call'), '');
  assert.equal(applyReasonChip('On-call', 'Launch'), 'Launch');
  assert.equal(applyReasonChip('Pager rotation', 'On-call'), 'On-call: Pager rotation');
  assert.equal(applyReasonChip('On-call: Pager rotation', 'Incident'), 'Incident: Pager rotation');
  assert.equal(applyReasonChip('On-call: Pager rotation', 'On-call'), 'Pager rotation');
  assert.equal(reasonChip('On-call: x'), 'On-call');
  assert.equal(reasonChip('On-calls'), null);
});
const mk = (status: string, startsAt: string, endsAt: string, extraCents = 5000) => ({ status, startsAt, endsAt, extraCents }) as any;
test('remaining / live / summary', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(remaining(mk('active', '2026-10-13T00:00:00Z', '2026-10-15T16:00:00Z'), now), '2d 4h left');
  assert.equal(remaining(mk('scheduled', '2026-10-13T15:00:00Z', '2026-10-15T16:00:00Z'), now), 'starts in 3h');
  assert.equal(remaining(mk('ended', '', ''), now), null);
  assert.ok(isLive({ status: 'scheduled' }) && isLive({ status: 'active' }) && !isLive({ status: 'ended' }));
  assert.deepEqual(summarize([{ status: 'active' }, { status: 'active' }, { status: 'scheduled' }, { status: 'ended' }]), { active: 2, scheduled: 1 });
  assert.equal(statusInfo('failed').tone, 'crit');
  assert.equal(statusInfo('mystery').label, 'mystery');
});
test('primaryOverride prefers active, then soonest scheduled', () => {
  assert.equal(primaryOverride([]), null);
  assert.equal(primaryOverride([mk('ended', 'a', 'b')]), null);
  const a = mk('scheduled', '2026-10-20T00:00:00Z', 'x'), b = mk('scheduled', '2026-10-18T00:00:00Z', 'x'), c = mk('active', '2026-10-12T00:00:00Z', 'x');
  assert.equal(primaryOverride([a, b])!.o, b);
  const r = primaryOverride([a, b, c])!;
  assert.equal(r.o, c); assert.equal(r.more, 2);
});
test('badgeText', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');   // pinned: the badge turns into "overdue" once an active boost's end has passed
  assert.match(badgeText(mk('active', '2026-10-13T00:00:00Z', '2026-10-16T12:00:00Z', 5000), now), /^Boost \+\$50 until \w{3}, Oct 1[56]$/);
  assert.match(badgeText(mk('scheduled', '2026-10-19T12:00:00Z', '2026-10-26T12:00:00Z', 10000), now), /^Boost \+\$100 from /);
});
import { findOverlap } from '../src/logic/overrides.ts';
test('findOverlap only considers live boosts of the same period', () => {
  const o = (status: string, period: string, s: string, e: string) => ({ status, period, startsAt: s, endsAt: e }) as any;
  const list = [o('active', 'weekly', '2026-10-12T00:00:00Z', '2026-10-15T00:00:00Z'), o('ended', 'monthly', '2026-10-01T00:00:00Z', '2026-10-30T00:00:00Z'), o('scheduled', 'monthly', '2026-10-20T00:00:00Z', '2026-10-25T00:00:00Z')];
  const d = (s: string) => new Date(s);
  assert.equal(findOverlap(list, 'weekly', d('2026-10-14T00:00:00Z'), d('2026-10-16T00:00:00Z')), list[0]);
  assert.equal(findOverlap(list, 'weekly', d('2026-10-15T00:00:00Z'), d('2026-10-16T00:00:00Z')), null);   // touching is fine
  assert.equal(findOverlap(list, 'monthly', d('2026-10-13T00:00:00Z'), d('2026-10-14T00:00:00Z')), null);   // the ended one is ignored
  assert.equal(findOverlap(list, 'monthly', d('2026-10-24T00:00:00Z'), d('2026-10-27T00:00:00Z')), list[2]);
});

import { GRACE_MS, cancelOutcome, canRetry, grantOutcome, includedBoost, includesText, overdueMs, overdueText, retryOutcome, startLateMs, statusDisplay, supersedeText } from '../src/logic/overrides.ts';
const NOW = Date.parse('2026-10-13T12:00:00Z');
test('M5: an active boost past its end is an overdue warning, never "<1m left" or a green Active', () => {
  const o = mk('active', '2026-10-13T00:00:00Z', '2026-10-13T10:00:00Z');
  assert.equal(overdueMs(o, NOW), 2 * 3600_000);
  assert.equal(remaining(o, NOW), 'Overdue by 2 h: the cap has not been restored yet, check the scheduler.');
  const st = statusDisplay(o, NOW);
  assert.equal(st.label, 'Overdue'); assert.notEqual(st.tone, 'good'); assert.equal(st.tone, 'crit');
  assert.match(badgeText(o, NOW), /^Boost \+\$50 overdue by 2 h$/);
  // not yet overdue
  assert.equal(overdueMs(mk('active', '2026-10-13T00:00:00Z', '2026-10-13T13:00:00Z'), NOW), null);
  assert.equal(statusDisplay(mk('active', '2026-10-13T00:00:00Z', '2026-10-13T13:00:00Z'), NOW).label, 'Active');
  // inside the scheduler's normal lag it is a gentle warning, not an alarm
  const just = mk('active', '2026-10-13T00:00:00Z', new Date(NOW - 30_000).toISOString());
  assert.equal(statusDisplay(just, NOW).label, 'Ending'); assert.equal(statusDisplay(just, NOW).tone, 'warn'); assert.match(remaining(just, NOW)!, /Ended just now/);
  assert.equal(statusDisplay(mk('active', 'x', new Date(NOW - 10 * 60_000).toISOString()), NOW).tone, 'serious');
  assert.equal(overdueMs(mk('ended', 'x', '2026-10-01T00:00:00Z'), NOW), null);           // only ACTIVE boosts can be overdue
});
test('M5: the server overdue / overdueMs win when present, else it is computed', () => {
  const base = mk('active', '2026-10-13T00:00:00Z', '2026-10-13T11:30:00Z');             // 30 min past by the clock
  assert.equal(overdueMs({ ...base, overdue: false }, NOW), null);
  assert.equal(overdueMs({ ...base, overdue: true, overdueMs: 3 * 3600_000 }, NOW), 3 * 3600_000);
  assert.equal(overdueMs({ ...base, overdue: true }, NOW), 30 * 60_000);
  assert.equal(overdueMs({ ...base, overdue: true, overdueMs: 60_000 }, NOW), 30 * 60_000);   // server snapshot is older than now
  assert.equal(overdueMs({ ...base, endsAt: 'garbage', overdue: true, overdueMs: 7200_000 }, NOW), 7200_000);
  assert.equal(overdueMs({ ...base, endsAt: 'garbage' }, NOW), null);
});
test('M5: a scheduled boost that never started is flagged too', () => {
  const o = mk('scheduled', '2026-10-13T09:00:00Z', '2026-10-15T00:00:00Z');
  assert.equal(startLateMs(o, NOW), 3 * 3600_000);
  assert.equal(statusDisplay(o, NOW).label, 'Late to start');
  assert.match(remaining(o, NOW)!, /Should have started 3 h ago/);
  assert.equal(startLateMs(mk('scheduled', new Date(NOW - 30_000).toISOString(), 'x'), NOW), null);
});
test('M5: retry is offered only for failed boosts whose window is still open', () => {
  assert.ok(canRetry({ status: 'failed', endsAt: '2026-10-14T00:00:00Z' }, NOW));
  assert.ok(!canRetry({ status: 'failed', endsAt: '2026-10-12T00:00:00Z' }, NOW));
  assert.ok(!canRetry({ status: 'active', endsAt: '2026-10-14T00:00:00Z' }, NOW));
});
const gctx = { name: 'Fatima', period: 'weekly' as const, extraCents: 5000, now: NOW };
test('M4: grant toast reflects the returned status and note', () => {
  const act = grantOutcome({ status: 'active', startsAt: '2026-10-13T12:00:00Z', note: null }, gctx);
  assert.equal(act.kind, 'ok'); assert.match(act.text, /^Boost active: \+\$50 weekly for Fatima\.$/);
  const sch = grantOutcome({ status: 'scheduled', startsAt: '2026-10-19T04:00:00Z', note: null }, gctx);
  assert.equal(sch.kind, 'ok'); assert.match(sch.text, /^Boost scheduled: \+\$50 weekly for Fatima from \w{3}, Oct 19\.$/);
  assert.doesNotMatch(sch.text, /granted/);
  // gateway down: server returns scheduled-now with a retry note -> a warning, not a success
  const down = grantOutcome({ status: 'scheduled', startsAt: '2026-10-13T12:00:00Z', note: 'will retry: gateway 503' }, gctx);
  assert.equal(down.kind, 'warn'); assert.match(down.text, /^Could not apply yet: will retry\. Gateway 503\.$/);
  const failed = grantOutcome({ status: 'failed', startsAt: '2026-10-13T12:00:00Z', note: 'no cap to extend' }, gctx);
  assert.equal(failed.kind, 'warn'); assert.match(failed.text, /could not be applied: no cap to extend/);
  assert.equal(grantOutcome(null, gctx).kind, 'warn');
  assert.equal(grantOutcome({ status: 'active', startsAt: 'x', note: 'cap rounded' }, gctx).kind, 'warn');
});
test('M4: cancel toast never claims a restore that did not happen', () => {
  const hand = cancelOutcome('active', { status: 'cancelled', note: 'the personal limit was changed by hand during the boost, so it was left as it is' });
  assert.equal(hand.kind, 'warn'); assert.match(hand.text, /^Cancelled\. The personal limit was changed by hand during the boost, so it was left as it is\.$/i); assert.doesNotMatch(hand.text, /restored/);
  assert.match(cancelOutcome('active', { status: 'cancelled', note: null }).text, /previous limit was restored/);
  const sched = cancelOutcome('scheduled', { status: 'cancelled', note: null });
  assert.equal(sched.kind, 'ok'); assert.doesNotMatch(sched.text, /restored/); assert.match(sched.text, /never changed/);
  const odd = cancelOutcome('active', { status: 'superseded', note: null }); assert.equal(odd.kind, 'warn'); assert.doesNotMatch(odd.text, /restored/);
  assert.equal(cancelOutcome('active', null).kind, 'ok');
});
test('M4: retry toast', () => {
  assert.equal(retryOutcome({ status: 'active', note: null }).kind, 'ok');
  assert.equal(retryOutcome({ status: 'failed', note: 'gateway 503' }).kind, 'warn');
});
test('M3: a boost is found when the personal cap equals its target, and says so', () => {
  const o = { status: 'active', period: 'weekly', targetCents: 25000, extraCents: 5000, baseCents: 20000, endsAt: '2026-10-16T12:00:00Z' } as any;
  const mkb = (cap: number | null, source: string | null = 'user', unlimited = false) => ({ capCents: cap, source, unlimited });
  assert.equal(includedBoost(mkb(25000), [o], 'weekly'), o);
  assert.equal(includedBoost(mkb(25000), [o], 'monthly'), null);
  assert.equal(includedBoost(mkb(9000), [o], 'weekly'), null);                      // hand-edited: cap no longer equals target
  assert.equal(includedBoost(mkb(25000, 'organization'), [o], 'weekly'), null);
  assert.equal(includedBoost(mkb(25000, 'user', true), [o], 'weekly'), null);
  assert.equal(includedBoost(mkb(25000), [{ ...o, status: 'scheduled' }], 'weekly'), null);
  assert.equal(includedBoost(undefined, [o], 'weekly'), null); assert.equal(includedBoost(mkb(25000), undefined, 'weekly'), null);
  assert.match(includesText(o, NOW), /^Includes \+\$50 boost until \w{3}, Oct 16 \(base \$200\)$/);
  assert.match(includesText({ ...o, baseCents: null }, NOW), /^Includes \+\$50 boost until \w{3}, Oct 16$/);
  assert.match(includesText({ ...o, endsAt: '2026-10-13T09:00:00Z' }, NOW), /should have ended 3 h ago \(base \$200\)$/);
  const w = supersedeText(o); assert.match(w, /replaces the boosted cap/); assert.match(w, /superseded/); assert.match(w, /Cancel the boost first/);
});
test('GRACE is two minutes', () => assert.equal(GRACE_MS, 120_000));
