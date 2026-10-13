// DST maths needs a zone with clock changes; this file runs in its own process, so setting TZ here is safe.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, HOUR_MS, endFrom, maxDaysOf, planWindow, startOf, boostError } from '../src/logic/overrides.ts';

const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / HOUR_MS;

test('TZ is a DST zone (guard for the tests below)', () => {
  const a = new Date(2026, 9, 31, 12), b = new Date(2026, 10, 2, 12);       // across the 1 Nov 2026 fall-back
  assert.equal(hours(a, b), 49);
});
test('a 90-day boost across the autumn clock change is clamped below the server limit (was 2161 h, rejected)', () => {
  const now = new Date(2026, 9, 13, 16, 0);
  const raw = endFrom(startOf('now', now), 90);
  assert.equal(hours(now, raw), 2161);                                           // the original bug: more than 90 x 24
  const p = planWindow('now', 90, now);
  assert.ok(p.clamped);
  assert.ok(hours(p.start, p.end) <= 90 * 24 - 1, `got ${hours(p.start, p.end)} h`);
  assert.equal(hours(p.start, p.end), 2159);
  for (const kind of ['tomorrow', 'monday'] as const) { const q = planWindow(kind, 90, now); assert.ok(q.end.getTime() - q.start.getTime() <= 90 * DAY_MS, kind); }
});
test('across the spring clock change a 90-day boost is shorter, not clamped', () => {
  const now = new Date(2027, 1, 20, 9, 0);                                       // Feb -> May crosses 14 Mar 2027
  const p = planWindow('now', 90, now);
  assert.equal(hours(p.start, p.end), 2159); assert.equal(p.clamped, false);
  assert.equal(p.end.getHours(), 9);                                             // wall-clock time kept
});
test('short boosts keep the wall-clock time over a DST change', () => {
  const now = new Date(2026, 9, 31, 22, 0);
  const p = planWindow('now', 3, now);
  assert.equal(p.end.getHours(), 22); assert.equal(p.clamped, false); assert.equal(hours(p.start, p.end), 73);
});
test('the server maximum is read from health when it reports one, else 90', () => {
  assert.equal(maxDaysOf(undefined), 90); assert.equal(maxDaysOf(0), 90); assert.equal(maxDaysOf(-3), 90); assert.equal(maxDaysOf(NaN), 90); assert.equal(maxDaysOf(30), 30);
  const now = new Date(2026, 9, 13, 16, 0);
  const p = planWindow('now', 60, now, 30);
  assert.ok(p.clamped); assert.equal(hours(p.start, p.end), 30 * 24 - 1);
  const ok = { extraCents: 5000, reason: 'On-call', capCents: 20000, unlimited: false };
  assert.match(boostError({ ...ok, days: 45, maxDays: 30 })!, /more than 30 days/);
  assert.equal(boostError({ ...ok, days: 30, maxDays: 30 }), null);
  assert.match(boostError({ ...ok, days: 91 })!, /more than 90 days/);
});
test('the window is computed from the clock passed in, so a later submit gets a later window', () => {
  const early = planWindow('now', 3, new Date(2026, 9, 13, 8, 0)), late = planWindow('now', 3, new Date(2026, 9, 13, 20, 0));
  assert.equal(hours(early.end, late.end), 12); assert.equal(late.startsAt, undefined);
  const t1 = planWindow('tomorrow', 3, new Date(2026, 9, 13, 23, 59)), t2 = planWindow('tomorrow', 3, new Date(2026, 9, 14, 0, 1));
  assert.notEqual(t1.start.getTime(), t2.start.getTime());                       // crossing midnight changes "tomorrow": the form must notice
});
