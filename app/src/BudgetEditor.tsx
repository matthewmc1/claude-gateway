import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View, Text } from 'react-native';
import { Budget, BudgetPayload, Override, Period, isCancelled } from './api';
import { useAuth } from './auth';
import { font, budgetState, pointer, useTheme } from './theme';
import { AdminTag, Button, Card, Chip, Segmented, Txt } from './ui';
import { BudgetBar } from './charts';
import { Icon } from './icons';
import { oneLine, usd as money } from './format';
import { MAX_CENTS, centsToText, centsToUsd, parseMoney, sanitizeMoneyInput } from './logic/money';
import { OrgImpact, PersonCaps, orgImpact } from './logic/impact';
import { includesText, overdueMs, supersedeText, GRACE_MS } from './logic/overrides';

type Mode = 'default' | 'custom' | 'unlimited' | 'none';
const STEP = 5;
const label = (c: number | null) => (c === null ? 'No cap' : money(c));

function Slider({ value, max, onChange, color }: { value: number; max: number; onChange: (v: number) => void; color: string }) {
  const { t } = useTheme();
  const [w, setW] = useState(0);
  const set = (x: number) => { if (w <= 0) return; const raw = Math.min(1, Math.max(0, x / w)) * max; onChange(Math.min(max, Math.max(0, Math.round(raw / STEP) * STEP))); };
  const frac = Math.min(1, value / max);
  return (
    <View style={{ height: 34, justifyContent: 'center' }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: t.track }} />
      <View style={{ position: 'absolute', left: 0, width: frac * w, height: 6, borderRadius: 3, backgroundColor: color }} />
      <View pointerEvents="none" style={[{ position: 'absolute', left: Math.max(0, frac * w - 11), width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', borderWidth: 3, borderColor: color }, { boxShadow: '0 2px 8px rgba(0,0,0,0.35)' } as any]} />
      <View accessibilityRole="adjustable" accessibilityLabel="Budget amount" accessibilityValue={{ min: 0, max, now: value }}
        {...({ tabIndex: 0, onKeyDown: (e: any) => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(max, value + STEP)); } if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(0, value - STEP)); } } } as any)}
        onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => set(e.nativeEvent.locationX)} onResponderMove={(e) => set(e.nativeEvent.locationX)}
        style={[{ position: 'absolute', left: -6, right: -6, top: 0, bottom: 0 }, pointer]} />
    </View>
  );
}

export function BudgetEditor({ kind, period, budget, own, defaultCents, onSave, subject, boost, onCancelBoost, people, style }: {
  kind: 'user' | 'org'; period: Period; budget?: Budget; own: { amountCents: number | null } | undefined; defaultCents?: number | null;
  onSave: (p: BudgetPayload) => Promise<void>; subject: string;
  /** User editor: the live boost whose boosted cap is this person's personal cap right now (so saving would supersede it). */
  boost?: Override | null; onCancelBoost?: (o: Override) => Promise<void>;
  /** Org editor: everyone the app knows, to show who relies on the company default. null = could not load. */
  people?: PersonCaps[] | null; style?: any;
}) {
  const { t } = useTheme();
  const { admin, iap } = useAuth();
  const who = oneLine(subject);
  const fallbackCents = defaultCents != null ? defaultCents : period === 'weekly' ? 5000 : 20000;
  const init = useMemo(() => {
    if (kind === 'user') return own === undefined ? { mode: 'default' as Mode, cents: fallbackCents } : own.amountCents === null ? { mode: 'unlimited' as Mode, cents: fallbackCents } : { mode: 'custom' as Mode, cents: own.amountCents };
    return own === undefined || own.amountCents === null ? { mode: 'none' as Mode, cents: fallbackCents } : { mode: 'custom' as Mode, cents: own.amountCents };
  }, [kind, own, fallbackCents]);

  const [mode, setMode] = useState<Mode>(init.mode);
  const [text, setText] = useState(centsToText(init.cents));
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [armed, setArmed] = useState(false);
  const key = `${init.mode}:${init.cents}`;
  const lastKey = useRef(key);
  const keepDraft = useRef(false);               // after "Cancel boost first" the person's unsaved edit must survive the refresh
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (keepDraft.current) { keepDraft.current = false; return; }
    setMode(init.mode); setText(centsToText(init.cents)); setArmed(false);
  }, [key, init]);
  useEffect(() => { if (!saved) return; const id = setTimeout(() => setSaved(false), 2200); return () => clearTimeout(id); }, [saved]);

  const parsed = parseMoney(text, { allowZero: true });
  const cents = parsed.ok ? parsed.cents : null;
  const invalid = mode === 'custom' && !parsed.ok;
  const blank = invalid && !parsed.ok && parsed.error === null;
  const shownCents = cents ?? init.cents;
  const usd = shownCents / 100;
  const baseUsd = Math.max(200, Math.ceil((Math.max(init.cents / 100, fallbackCents / 100) * 1.8) / 50) * 50);
  const max = usd > baseUsd ? Math.min(MAX_CENTS / 100, Math.ceil((usd * 1.25) / 50) * 50) : baseUsd;
  const edit = () => { setArmed(false); setSaved(false); setErr(null); };
  const setAmountCents = (c: number) => { const v = Math.min(MAX_CENTS, Math.max(0, Math.round(c))); setText(centsToText(v)); edit(); };
  const pick = (m: Mode) => { setMode(m); setArmed(false); setErr(null); setSaved(false); };

  const nextCap: number | null = mode === 'custom' ? cents : mode === 'default' ? (defaultCents ?? null) : null;
  const curCap: number | null = kind === 'user' ? (budget?.capCents ?? null) : (own?.amountCents ?? null);
  const dirty = mode !== init.mode || (mode === 'custom' && (invalid || cents !== init.cents));
  const canSave = dirty && !invalid;
  const spend = budget?.spendCents ?? 0;
  const st = budget ? budgetState(t, spend, budget.capCents, budget.unlimited) : null;
  const unitWord = period === 'weekly' ? 'week' : 'month';

  const delta = nextCap !== null && curCap !== null ? nextCap - curCap : null;
  const blocks = kind === 'user' && mode !== 'unlimited' && nextCap !== null && (nextCap === 0 || spend >= nextCap);
  const impact: OrgImpact | null = kind === 'org' && canSave ? orgImpact(people, period, curCap, nextCap) : null;
  const risky = canSave && (kind === 'user' ? blocks : !!impact?.needsConfirm);
  const supersedes = kind === 'user' && canSave && !!boost;

  const apply = async () => {
    if (!canSave) return;
    if (risky && !armed && !supersedes) { setArmed(true); return; }
    setBusy(true); setErr(null);
    try {
      const payload: BudgetPayload = mode === 'custom' ? { period, action: 'set', usd: centsToUsd(cents!) } : mode === 'unlimited' ? { period, action: 'unlimited' } : { period, action: 'inherit' };
      await onSave(payload); setSaved(true); setArmed(false);
    } catch (e: any) { if (!isCancelled(e)) setErr(oneLine(e.message || 'Could not save')); } finally { setBusy(false); }
  };
  const cancelBoostFirst = async () => {
    if (!boost || !onCancelBoost) return;
    setCancelling(true); setErr(null); keepDraft.current = true;
    try { await onCancelBoost(boost); } catch (e: any) { keepDraft.current = false; if (!isCancelled(e)) setErr(oneLine(e.message || 'Could not cancel the boost')); } finally { setCancelling(false); }
  };

  const modes = kind === 'user'
    ? [{ value: 'default' as Mode, label: 'Company default' }, { value: 'custom' as Mode, label: 'Custom' }, { value: 'unlimited' as Mode, label: 'Unlimited' }]
    : [{ value: 'none' as Mode, label: 'No cap' }, { value: 'custom' as Mode, label: 'Set a cap' }];

  const sourceNote = kind === 'org' ? `Every person gets this cap each ${unitWord} unless they have their own.`
    : boost && init.mode === 'custom' ? `Personal cap for ${who}, currently raised by a temporary boost.` : init.mode === 'custom' ? `Personal cap for ${who}.` : init.mode === 'unlimited' ? `Personal override: ${who} is exempt from the company default.`
    : defaultCents != null ? `Inheriting the company default of ${money(defaultCents)}.` : 'No company default is set, so there is no limit.';
  const od = boost ? overdueMs(boost) : null;
  const zeroOrg = kind === 'org' && mode === 'custom' && cents === 0;

  return (
    <Card style={[{ gap: 16 }, style]} pad={18}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          <Txt v="h3">{period === 'weekly' ? 'Weekly budget' : 'Monthly budget'}</Txt>
          <AdminTag signedIn={!!admin} iap={iap} />
        </View>
        {st ? <Chip label={st.label} color={st.color} /> : null}
      </View>

      {budget ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <Txt v="metric">{money(spend)}</Txt>
            <Txt v="body" color="muted">{budget.unlimited ? 'spent, no limit' : budget.capCents === null ? 'spent, no cap' : `of ${money(budget.capCents)} this ${unitWord}`}</Txt>
          </View>
          <BudgetBar pct={st?.pct ?? 0} color={st?.color ?? t.muted} />
          {boost ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip icon={od !== null && od >= GRACE_MS ? 'alert' : 'bolt'} label={od !== null && od >= GRACE_MS ? 'Boost overdue' : 'Boosted'} color={od !== null && od >= GRACE_MS ? t.crit : t.accent} />
              <Txt v="small" color="text2" style={{ flex: 1, minWidth: 180 }}>{includesText(boost)}</Txt>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <Segmented options={modes} value={mode} onChange={pick} small />
        <Txt v="small" color="muted">{sourceNote}</Txt>
      </View>

      {mode === 'custom' && (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Decrease by $${STEP}`} onPress={() => setAmountCents(Math.max(0, shownCents - STEP * 100))} style={(s: any) => [stepBtn(t, s.hovered), pointer]}><Icon name="minus" size={16} color={t.text} /></Pressable>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface2, borderRadius: 12, borderWidth: 1, borderColor: invalid && !blank ? t.crit : t.borderStrong, paddingHorizontal: 14, height: 48 }}>
              <Text style={{ fontFamily: font(600), fontSize: 20, color: t.muted, marginRight: 4 }}>$</Text>
              <TextInput value={text} accessibilityLabel={`${period} budget in dollars`} inputMode="decimal" selectTextOnFocus maxLength={14}
                onChangeText={(s) => { setText(sanitizeMoneyInput(s)); edit(); }}
                onBlur={() => { const p = parseMoney(text, { allowZero: true }); if (p.ok) setText(centsToText(p.cents)); }}
                style={[{ flex: 1, minWidth: 0, fontFamily: font(700), fontSize: 22, color: t.text, padding: 0 }, { outlineStyle: 'none' } as any]} />
              <Txt v="small" color="muted">/ {unitWord}</Txt>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Increase by $${STEP}`} onPress={() => setAmountCents(shownCents + STEP * 100)} style={(s: any) => [stepBtn(t, s.hovered), pointer]}><Icon name="plus" size={16} color={t.text} /></Pressable>
          </View>
          {invalid && !blank ? <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}><Icon name="alert" size={15} color={t.crit} /><Txt v="small" color={t.crit} style={{ flex: 1 }}>{!parsed.ok ? parsed.error : ''}</Txt></View> : null}
          {blank ? <Txt v="small" color="muted">Enter an amount in dollars to save.</Txt> : null}
          <Slider value={Math.min(usd, max)} max={max} onChange={(v) => setAmountCents(v * 100)} color={t.accent} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[25, 50, 100, 250, 500, 1000].filter((p) => p <= max).map((p) => {
              const on = shownCents === p * 100 && !invalid;
              return (
                <Pressable key={p} accessibilityRole="button" accessibilityLabel={`Set to $${p}`} onPress={() => setAmountCents(p * 100)} style={(s: any) => [{ paddingHorizontal: 12, height: 28, borderRadius: 14, justifyContent: 'center', backgroundColor: on ? t.accentSoft : s.hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: on ? t.accent : t.border }, pointer]}>
                  <Text style={{ fontFamily: font(600), fontSize: 12.5, color: on ? t.accent : t.text2 }}>${p}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {dirty && !invalid && (
        <View style={{ gap: 8, backgroundColor: t.surface2, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: t.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Txt v="body" color="text2">{label(curCap)}</Txt><Icon name="chevron" size={14} color={t.muted} />
            <Txt v="body" style={{ fontFamily: font(700) }}>{mode === 'unlimited' ? 'Unlimited' : label(nextCap)}</Txt>
            {delta !== null && delta !== 0 ? <Chip label={`${money(delta, { signed: true })} per ${unitWord}`} color={delta > 0 ? t.good : t.warn} /> : null}
          </View>
          {blocks ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="alert" size={15} color={t.serious} />
              <Txt v="small" color={t.serious} style={{ flex: 1 }}>{nextCap === 0 ? `A $0 cap blocks every request from ${who}.` : `${who} has already spent ${money(spend)}, so requests are blocked until the ${unitWord} resets or the cap is raised.`}</Txt>
            </View>
          ) : null}
          {kind === 'org' && impact ? impact.lines.map((l, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="alert" size={15} color={impact.needsConfirm ? t.serious : t.muted} />
              <Txt v="small" color={impact.needsConfirm ? t.serious : 'text2'} style={{ flex: 1 }}>{l}</Txt>
            </View>
          )) : null}
          {kind === 'org' && impact && people ? <Txt v="small" color="muted">Counts the {people.length} {people.length === 1 ? 'person' : 'people'} the gateway has seen. People with their own personal cap keep it; live boosts built on the default are re-based.</Txt> : null}
        </View>
      )}
      {zeroOrg && !impact ? <Txt v="small" color={t.serious}>A $0 default blocks everyone who has no personal cap.</Txt> : null}

      {supersedes && boost ? (
        <View accessibilityRole="alert" style={{ gap: 6, backgroundColor: t.serious + '14', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: t.serious + '66' }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Icon name="bolt" size={15} color={t.serious} /><Txt v="h3" color={t.serious}>This replaces a live boost</Txt></View>
          <Txt v="small" color="text2">{supersedeText(boost)}</Txt>
        </View>
      ) : null}

      {err ? <Txt v="small" color={t.crit} accessibilityRole="alert">{err}</Txt> : null}
      {supersedes && boost ? (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {onCancelBoost ? <Button label="Cancel boost first" icon="undo" busy={cancelling} disabled={busy} onPress={cancelBoostFirst} style={{ flexGrow: 1 }} /> : null}
          <Button kind="danger" label={risky ? 'Save anyway and block' : 'Save anyway'} busy={busy} disabled={cancelling} onPress={apply} style={{ flexGrow: 1 }} />
          <Button label="Reset" icon="undo" onPress={() => { setMode(init.mode); setText(centsToText(init.cents)); setErr(null); setArmed(false); }} />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Button kind={armed ? 'danger' : 'primary'} label={armed ? (kind === 'org' && !(impact?.allBlocked || impact?.newlyBlocked) ? 'Confirm change' : 'Confirm and block') : saved ? 'Saved' : 'Save changes'} icon={saved ? 'check' : admin ? undefined : 'lock'} disabled={!canSave} busy={busy} onPress={apply} style={{ flex: 1 }} />
          {dirty ? <Button label="Reset" icon="undo" onPress={() => { setMode(init.mode); setText(centsToText(init.cents)); setErr(null); setArmed(false); }} /> : null}
        </View>
      )}
    </Card>
  );
}
const stepBtn = (t: any, hovered: boolean) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: t.border });
