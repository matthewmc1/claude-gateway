import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View, Text } from 'react-native';
import { Budget, BudgetPayload, Period } from './api';
import { font, budgetState, pointer, useTheme } from './theme';
import { Button, Card, Chip, Segmented, Txt } from './ui';
import { BudgetBar } from './charts';
import { Icon } from './icons';
import { usd as money } from './format';

type Mode = 'default' | 'custom' | 'unlimited' | 'none';
const STEP = 5, HARD_MAX = 100000;
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

export function BudgetEditor({ kind, period, budget, own, defaultCents, onSave, subject }: {
  kind: 'user' | 'org'; period: Period; budget?: Budget; own: { amountCents: number | null } | undefined; defaultCents?: number | null;
  onSave: (p: BudgetPayload) => Promise<void>; subject: string;
}) {
  const { t } = useTheme();
  const fallback = defaultCents != null ? defaultCents / 100 : period === 'weekly' ? 50 : 200;
  const init = useMemo(() => {
    if (kind === 'user') return own === undefined ? { mode: 'default' as Mode, usd: fallback } : own.amountCents === null ? { mode: 'unlimited' as Mode, usd: fallback } : { mode: 'custom' as Mode, usd: own.amountCents / 100 };
    return own === undefined || own.amountCents === null ? { mode: 'none' as Mode, usd: fallback } : { mode: 'custom' as Mode, usd: own.amountCents / 100 };
  }, [kind, own, fallback]);

  const [mode, setMode] = useState<Mode>(init.mode);
  const [usd, setUsd] = useState(init.usd);
  const [text, setText] = useState(String(init.usd));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [armed, setArmed] = useState(false);
  const key = `${init.mode}:${init.usd}`;
  const lastKey = useRef(key);
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; setMode(init.mode); setUsd(init.usd); setText(String(init.usd)); setArmed(false); } }, [key, init]);
  useEffect(() => { if (!saved) return; const id = setTimeout(() => setSaved(false), 2200); return () => clearTimeout(id); }, [saved]);

  const base = Math.max(200, Math.ceil((Math.max(init.usd, fallback) * 1.8) / 50) * 50);
  const max = usd > base ? Math.min(HARD_MAX, Math.ceil((usd * 1.25) / 50) * 50) : base;
  const setAmount = (v: number) => { const c = Math.min(HARD_MAX, Math.max(0, Math.round(v * 100) / 100)); setUsd(c); setText(String(c)); setArmed(false); setSaved(false); };
  const pick = (m: Mode) => { setMode(m); setArmed(false); setErr(null); setSaved(false); };

  const nextCap: number | null = mode === 'custom' ? Math.round(usd * 100) : mode === 'default' ? (defaultCents ?? null) : null;
  const curCap: number | null = kind === 'user' ? (budget?.capCents ?? null) : (own?.amountCents ?? null);
  const dirty = mode !== init.mode || (mode === 'custom' && Math.round(usd * 100) !== Math.round(init.usd * 100));
  const spend = budget?.spendCents ?? 0;
  const st = budget ? budgetState(t, spend, budget.capCents, budget.unlimited) : null;
  const unitWord = period === 'weekly' ? 'week' : 'month';

  const delta = nextCap !== null && curCap !== null ? nextCap - curCap : null;
  const blocks = kind === 'user' && mode !== 'unlimited' && nextCap !== null && (nextCap === 0 || spend >= nextCap);
  const risky = dirty && blocks;

  const apply = async () => {
    if (risky && !armed) { setArmed(true); return; }
    setBusy(true); setErr(null);
    try {
      const payload: BudgetPayload = mode === 'custom' ? { period, action: 'set', usd } : mode === 'unlimited' ? { period, action: 'unlimited' } : { period, action: 'inherit' };
      await onSave(payload); setSaved(true); setArmed(false);
    } catch (e: any) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  };

  const modes = kind === 'user'
    ? [{ value: 'default' as Mode, label: 'Company default' }, { value: 'custom' as Mode, label: 'Custom' }, { value: 'unlimited' as Mode, label: 'Unlimited' }]
    : [{ value: 'none' as Mode, label: 'No cap' }, { value: 'custom' as Mode, label: 'Set a cap' }];

  const sourceNote = kind === 'org' ? `Every person gets this cap each ${unitWord} unless they have their own.`
    : init.mode === 'custom' ? `Personal cap for ${subject}.` : init.mode === 'unlimited' ? `Personal override: ${subject} is exempt from the company default.`
    : defaultCents != null ? `Inheriting the company default of ${money(defaultCents)}.` : 'No company default is set, so there is no limit.';

  return (
    <Card style={{ flex: 1, minWidth: 280, gap: 16 }} pad={18}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="h3">{period === 'weekly' ? 'Weekly budget' : 'Monthly budget'}</Txt>
        {st ? <Chip label={st.label} color={st.color} /> : null}
      </View>

      {budget ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Txt v="metric">{money(spend)}</Txt>
            <Txt v="body" color="muted">{budget.unlimited ? 'spent, no limit' : budget.capCents === null ? 'spent, no cap' : `of ${money(budget.capCents)} this ${unitWord}`}</Txt>
          </View>
          <BudgetBar pct={st?.pct ?? 0} color={st?.color ?? t.muted} />
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <Segmented options={modes} value={mode} onChange={pick} small />
        <Txt v="small" color="muted">{sourceNote}</Txt>
      </View>

      {mode === 'custom' && (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable accessibilityLabel={`Decrease by $${STEP}`} onPress={() => setAmount(Math.max(0, usd - STEP))} style={(s: any) => [stepBtn(t, s.hovered), pointer]}><Icon name="minus" size={16} color={t.text} /></Pressable>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface2, borderRadius: 12, borderWidth: 1, borderColor: t.borderStrong, paddingHorizontal: 14, height: 48 }}>
              <Text style={{ fontFamily: font(600), fontSize: 20, color: t.muted, marginRight: 4 }}>$</Text>
              <TextInput value={text} accessibilityLabel={`${period} budget in dollars`} inputMode="decimal" selectTextOnFocus
                onChangeText={(s) => { const clean = s.replace(/[^0-9.]/g, ''); setText(clean); const v = parseFloat(clean); if (!Number.isNaN(v)) { setUsd(Math.min(HARD_MAX, v)); setArmed(false); setSaved(false); } }}
                onBlur={() => setText(String(usd))} style={[{ flex: 1, fontFamily: font(700), fontSize: 22, color: t.text, padding: 0 }, { outlineStyle: 'none' } as any]} />
              <Txt v="small" color="muted">/ {unitWord}</Txt>
            </View>
            <Pressable accessibilityLabel={`Increase by $${STEP}`} onPress={() => setAmount(usd + STEP)} style={(s: any) => [stepBtn(t, s.hovered), pointer]}><Icon name="plus" size={16} color={t.text} /></Pressable>
          </View>
          <Slider value={Math.min(usd, max)} max={max} onChange={setAmount} color={t.accent} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[25, 50, 100, 250, 500, 1000].filter((p) => p <= max).map((p) => {
              const on = Math.round(usd) === p;
              return (
                <Pressable key={p} onPress={() => setAmount(p)} style={(s: any) => [{ paddingHorizontal: 12, height: 28, borderRadius: 14, justifyContent: 'center', backgroundColor: on ? t.accentSoft : s.hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: on ? t.accent : t.border }, pointer]}>
                  <Text style={{ fontFamily: font(600), fontSize: 12.5, color: on ? t.accent : t.text2 }}>${p}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {dirty && (
        <View style={{ gap: 8, backgroundColor: t.surface2, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: t.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Txt v="body" color="text2">{label(curCap)}</Txt><Icon name="chevron" size={14} color={t.muted} />
            <Txt v="body" style={{ fontFamily: font(700) }}>{mode === 'unlimited' ? 'Unlimited' : label(nextCap)}</Txt>
            {delta !== null && delta !== 0 ? <Chip label={`${money(delta, { signed: true })} per ${unitWord}`} color={delta > 0 ? t.good : t.warn} /> : null}
          </View>
          {blocks ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="alert" size={15} color={t.serious} />
              <Txt v="small" color={t.serious} style={{ flex: 1 }}>{nextCap === 0 ? `A $0 cap blocks every request from ${subject}.` : `${subject} has already spent ${money(spend)}, so requests are blocked until the ${unitWord} resets or the cap is raised.`}</Txt>
            </View>
          ) : null}
        </View>
      )}

      {err ? <Txt v="small" color={t.crit}>{err}</Txt> : null}
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Button kind={armed ? 'danger' : 'primary'} label={armed ? 'Confirm and block' : saved ? 'Saved' : 'Save changes'} icon={saved ? 'check' : undefined} disabled={!dirty} busy={busy} onPress={apply} style={{ flex: 1 }} />
        {dirty ? <Button label="Reset" icon="undo" onPress={() => { setMode(init.mode); setAmount(init.usd); setErr(null); setArmed(false); }} /> : null}
      </View>
    </Card>
  );
}
const stepBtn = (t: any, hovered: boolean) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: t.border });
