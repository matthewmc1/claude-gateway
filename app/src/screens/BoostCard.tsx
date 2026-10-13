import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DetailRes, Override, Period, cancelOverride, createOverride, isCancelled } from '../api';
import { useAuth } from '../auth';
import { useNow } from '../hooks';
import { font, pointer, useTheme } from '../theme';
import { AdminTag, Button, Card, Chip, Segmented, TextField, Txt, useToast } from '../ui';
import { Icon } from '../icons';
import { dayTime, oneLine, plain, plural, usd } from '../format';
import {
  DURATIONS, EXTRA_PRESETS, MAX_EXTRA_USD, REASON_CHIPS, REASON_MAX, START_OPTIONS, StartKind, applyReasonChip, boostError, cancelOutcome, capAfter, findOverlap, grantOutcome, isLive, maxDaysOf,
  overdueMs, parseDays, parseMoney, planWindow, reasonChip, GRACE_MS,
} from '../logic/overrides';
import { centsToUsd } from '../logic/money';
import { OverrideRow, useRetry } from './overrides-ui';

function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={(s: any) => [{ paddingHorizontal: 12, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: on ? t.accentSoft : s.hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: on ? t.accent : t.border }, pointer]}>
      <Text style={{ fontFamily: font(600), fontSize: 12.5, color: on ? t.accent : t.text2 }}>{label}</Text>
    </Pressable>
  );
}
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.');
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <View style={{ gap: 8 }}><Txt v="label">{label}</Txt>{children}</View>;

/** Admin action: raise a person's cap for a while. The backend restores their previous limit automatically when the window ends. */
export function BoostCard({ d, onChanged }: { d: DetailRes; onChanged: () => void | Promise<void> }) {
  const { t } = useTheme(); const toast = useToast(); const { admin, runAdmin, health } = useAuth();
  const [period, setPeriod] = useState<Period>('weekly');
  const [preset, setPreset] = useState<number | 'custom'>(50);
  const [customExtra, setCustomExtra] = useState('');
  const [start, setStart] = useState<StartKind>('now');
  const [dur, setDur] = useState('3d');
  const [customDays, setCustomDays] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [cancelling, setCancelling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const tick = useNow(30000);                    // keeps the preview honest on a form left open; submit reads the clock again

  const maxDays = maxDaysOf(health?.maxOverrideDays);
  const b = d.user.budgets[period];
  const money = preset === 'custom' ? parseMoney(customExtra, { max: MAX_EXTRA_USD, allowZero: false }) : { ok: true as const, cents: preset * 100 };
  const extraCents = money.ok ? money.cents : null;
  const extraErr = preset === 'custom' && !money.ok ? money.error : null;
  const dayParse = dur === 'custom' ? parseDays(customDays) : { ok: true as const, days: DURATIONS.find((x) => x.key === dur)!.days! };
  const days = dayParse.ok ? dayParse.days : null;
  const daysErr = dur === 'custom' && !dayParse.ok ? dayParse.error : days !== null && days > maxDays ? `A boost can last at most ${maxDays} days.` : null;
  const plan = useMemo(() => (days && days <= maxDays ? planWindow(start, days, new Date(tick), maxDays) : null), [start, days, tick, maxDays]);
  const problem = boostError({ extraCents, days, reason, capCents: b.capCents, unlimited: b.unlimited, maxDays });
  const clash = plan ? findOverlap(d.overrides, period, plan.start, plan.end) : null;
  const next = extraCents ? capAfter(b.capCents, extraCents) : null;
  const chip = reasonChip(reason);
  const list = all ? d.overrides : d.overrides.slice(0, 4);
  const overdue = d.overrides.filter((o) => (overdueMs(o, tick) ?? -1) >= GRACE_MS).length;
  const live = d.overrides.filter(isLive).length - overdue;
  const name = oneLine(d.user.name);
  const blocked = b.capCents === null || b.unlimited;
  const reload = useCallback(async () => { await onChanged(); }, [onChanged]);
  const { onRetry, retryBusy } = useRetry(reload, setErr);

  const submit = async () => {
    if (problem || days === null || extraCents === null) { setErr(problem); return; }
    // Read the clock NOW, not at mount: an idle form must never submit a window that began hours ago.
    const fresh = planWindow(start, days, new Date(), maxDays);
    if (plan && start !== 'now' && fresh.start.getTime() !== plan.start.getTime()) { setErr('The start moved past midnight while this form was open. Check the new dates above and submit again.'); return; }
    setBusy(true); setErr(null);
    try {
      const made = await runAdmin('Sign in as an admin to grant this boost.', () => createOverride({ sub: d.user.sub, period, extraUsd: centsToUsd(extraCents), ...(fresh.startsAt ? { startsAt: fresh.startsAt } : {}), endsAt: fresh.endsAt, reason: oneLine(reason) }));
      const out = grantOutcome(made, { name, period, extraCents });
      toast(out.text, out.kind);
      setReason(''); await onChanged();
    } catch (e: any) { if (!isCancelled(e)) setErr(sentence(plain(e.message || 'Could not create the boost'))); } finally { setBusy(false); }
  };
  const cancel = async (o: Override) => {
    setCancelling(o.id); setErr(null);
    try {
      const r = await runAdmin('Sign in as an admin to cancel this boost.', () => cancelOverride(o.id));
      const out = cancelOutcome(o.status, r); toast(out.text, out.kind); await onChanged();
    } catch (e: any) { if (!isCancelled(e)) setErr(sentence(plain(e.message || 'Could not cancel the boost'))); } finally { setCancelling(null); }
  };

  return (
    <Card style={{ gap: 18 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Icon name="bolt" size={18} color={t.accent} />
          <Txt v="h3">Temporary boost</Txt>
          <AdminTag signedIn={!!admin} />
          {live ? <Chip label={`${live} live`} color={t.good} /> : null}
          {overdue ? <Chip label={`${overdue} overdue`} color={t.crit} icon="alert" /> : null}
        </View>
        <Txt v="small" color="muted">On-call, a launch, an incident: raise {name}'s cap for a while. The cap goes back by itself when the window ends, so there is nothing to remember to undo.</Txt>
      </View>

      <Field label="Which budget">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <Segmented small value={period} onChange={(p) => { setPeriod(p); setErr(null); }} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
          <Txt v="small" color="muted">{b.unlimited ? 'Unlimited today' : b.capCents === null ? 'No cap today' : `Cap today ${usd(b.capCents)}, spent ${usd(b.spendCents)}`}</Txt>
        </View>
      </Field>

      <Field label="Extra budget">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {EXTRA_PRESETS.map((p) => <Pill key={p} label={`+$${p}`} on={preset === p} onPress={() => setPreset(p)} />)}
          <Pill label="Custom" on={preset === 'custom'} onPress={() => setPreset('custom')} />
          {preset === 'custom' ? <TextField value={customExtra} onChangeText={(s) => setCustomExtra(s.slice(0, 14))} label="Extra amount in dollars" prefix="+$" placeholder="75" inputMode="decimal" autoFocus invalid={!!extraErr} style={{ width: 140, minHeight: 36 }} /> : null}
        </View>
        {extraErr ? <Txt v="small" color={t.crit} accessibilityRole="alert">{extraErr}</Txt> : null}
      </Field>

      <Field label="Starts">
        <Segmented small value={start} onChange={setStart} options={START_OPTIONS} />
      </Field>

      <Field label="Lasts">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {DURATIONS.map((x) => <Pill key={x.key} label={x.label} on={dur === x.key} onPress={() => setDur(x.key)} />)}
          {dur === 'custom' ? <TextField value={customDays} onChangeText={(s) => setCustomDays(s.slice(0, 8))} label="Number of days" suffix="days" placeholder="5" inputMode="decimal" autoFocus invalid={!!daysErr} style={{ width: 130, minHeight: 36 }} /> : null}
        </View>
        {daysErr ? <Txt v="small" color={t.crit} accessibilityRole="alert">{daysErr}</Txt> : null}
      </Field>

      <Field label="Reason">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {REASON_CHIPS.map((c) => <Pill key={c} label={c} on={chip === c} onPress={() => setReason((r) => applyReasonChip(r, c))} />)}
        </View>
        <TextField value={reason} onChangeText={(s) => setReason(plain(s).slice(0, REASON_MAX))} label="Reason for the boost" placeholder="Why does this person need more budget? (3 to 200 characters)" multiline maxLength={REASON_MAX} />
        <Txt v="small" color="muted" style={{ textAlign: 'right' }}>{oneLine(reason).length}/{REASON_MAX}</Txt>
      </Field>

      <View style={{ gap: 8, backgroundColor: t.surface2, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: t.border }}>
        {plan ? (
          <>
            <Txt v="body">
              <Txt v="body" style={{ fontFamily: font(600) }}>{start === 'now' ? 'Now' : dayTime(plan.start)}</Txt> → <Txt v="body" style={{ fontFamily: font(600) }}>{dayTime(plan.end)}</Txt>
              <Txt v="small" color="muted">  ({plural(Math.round((plan.end.getTime() - plan.start.getTime()) / 8640000) / 10, 'day')})</Txt>
            </Txt>
            {plan.clamped ? <Txt v="small" color={t.serious}>Shortened slightly to stay inside the {maxDays}-day maximum a boost can last.</Txt> : null}
            {next !== null && extraCents ? <Txt v="small" color="text2">While it lasts, the {period} cap is {usd(b.capCents)} + {usd(extraCents)} = <Txt v="small" style={{ fontFamily: font(700) }}>{usd(next)}</Txt>, based on the cap when the boost starts.</Txt> : null}
          </>
        ) : <Txt v="small" color="muted">Choose how long the boost lasts to see the window.</Txt>}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <Icon name="undo" size={14} color={t.good} />
          <Txt v="small" color="text2" style={{ flex: 1 }}>Reverts automatically: when the window ends, {name}'s previous limit is restored. If someone changes their personal cap in the meantime, the boost is marked superseded and the newer value is kept.</Txt>
        </View>
        {clash ? <Txt v="small" color={t.serious}>{name} already has {clash.status === 'active' ? 'an active' : 'a scheduled'} {period} boost in this window. The server will refuse an overlapping one; cancel it first or pick other dates.</Txt> : null}
      </View>

      {err ? <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}><Icon name="alert" size={15} color={t.crit} /><Txt v="small" color={t.crit} style={{ flex: 1 }}>{err}</Txt></View> : null}
      {!err && problem && blocked ? <Txt v="small" color={t.muted}>{problem}</Txt> : null}
      <Button kind="primary" icon={admin ? 'bolt' : 'lock'} label={admin ? 'Grant boost' : 'Sign in to grant boost'} busy={busy} disabled={!!problem && (blocked || extraCents === null || days === null)} onPress={submit} />

      <View style={{ gap: 2 }}>
        <Txt v="label" style={{ marginBottom: 4 }}>Boosts for {name}</Txt>
        {d.overridesError ? <Txt v="small" color={t.serious} style={{ paddingTop: 6 }}>Boosts could not be loaded (stored state unreadable), so none are listed. Granting a new one is still possible but check the Activity page afterwards.</Txt> : d.overrides.length === 0 ? <Txt v="small" color="muted" style={{ paddingTop: 6 }}>No boosts yet. They appear here, with their status, once granted.</Txt> : list.map((o, i) => <OverrideRow key={o.id} o={o} first={i === 0} onCancel={cancel} onRetry={onRetry} retryBusy={retryBusy} busy={cancelling === o.id} />)}
        {!d.overridesError && d.overrides.length > 4 ? <View style={{ paddingTop: 6 }}><Button small kind="ghost" label={all ? 'Show fewer' : `Show all ${d.overrides.length}`} onPress={() => setAll((v) => !v)} /></View> : null}
      </View>
    </Card>
  );
}
