import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { BudgetPayload, DataSel, Override, Range, cancelOverride, getUser, setUserBudget } from '../api';
import { useAuth } from '../auth';
import { BoostCard } from './BoostCard';
import { useLoad, useModalFocus } from '../hooks';
import { budgetState, font, modelColor, pointer, useTheme } from '../theme';
import { Avatar, Card, Chip, IconButton, Notice, Skeleton, Txt, useToast, useTween } from '../ui';
import { Legend, StackedBars, HBars } from '../charts';
import { BudgetEditor } from '../BudgetEditor';
import { outcomeInfo } from '../outcome';
import { ago, clock, int, modelShort, oneLine, usd } from '../format';
import { cancelOutcome, includedBoost } from '../logic/overrides';
import { AuditRow } from './Activity';

export function UserDrawer({ sub, range, data, onClose, onChanged }: { sub: string; range: Range; data: DataSel; onClose: () => void; onChanged: () => void }) {
  const { t } = useTheme();
  const toast = useToast();
  const { runAdmin } = useAuth();
  const { width } = useWindowDimensions();
  const { data: d, error, reload } = useLoad(() => getUser(sub, range, data), [sub, range, data], 30000);
  const slide = useTween(1, 320);
  const panel = useRef<any>(null);
  useModalFocus(panel);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const save = (period: 'weekly' | 'monthly') => async (p: BudgetPayload) => {
    await runAdmin('Sign in as an admin to save this budget.', () => setUserBudget(sub, p)); await reload(); onChanged();
    toast(p.action === 'inherit' ? `Now using the company default (${period})` : p.action === 'unlimited' ? `${oneLine(d?.user.name ?? 'User')} is now unlimited (${period})` : `${period === 'weekly' ? 'Weekly' : 'Monthly'} budget set to ${usd(Math.round((p.usd ?? 0) * 100))}`);
  };
  // "Cancel boost first": cancel it, say what really happened, and refresh so the editor shows the restored cap.
  const cancelBoost = async (o: Override) => {
    const r = await runAdmin('Sign in as an admin to cancel this boost.', () => cancelOverride(o.id));
    const out = cancelOutcome(o.status, r); toast(out.text, out.kind); await reload(); onChanged();
  };

  const series = useMemo(() => d ? d.series.models.map((m) => ({ key: m, label: modelShort(m), color: modelColor(t, m), values: d.series.values[m] })) : [], [d, t]);
  const wide = width >= 760;
  const panelW = Math.min(width, 760);

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}>
      <Pressable accessibilityLabel="Close panel" onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.overlay, opacity: slide }} />
      <Animated.View ref={panel} accessibilityViewIsModal {...({ role: 'dialog', 'aria-modal': true, 'aria-label': 'Person details' } as any)} style={[{ position: 'absolute', top: 0, bottom: 0, right: 0, width: panelW, backgroundColor: t.bg, borderLeftWidth: 1, borderLeftColor: t.border, transform: [{ translateX: (1 - slide) * 80 }], opacity: Math.min(1, slide * 1.4) }, { boxShadow: t.shadow } as any]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 20, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface }}>
          {d ? <Avatar name={d.user.name} seed={sub.length + (sub.charCodeAt(3) || 0)} size={46} /> : <Skeleton h={46} w={46} r={23} />}
          <View style={{ flex: 1, gap: 2 }}>
            {d ? <><Txt v="h2" numberOfLines={1}>{d.user.name}</Txt><Txt v="small" color="muted" numberOfLines={1}>{d.user.email ?? sub}</Txt></> : <><Skeleton h={18} w={160} /><Skeleton h={12} w={220} /></>}
          </View>
          <IconButton icon="x" label="Close" onPress={onClose} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 60 }}>
          {error && !d ? <Card><Txt color={t.crit}>{error}</Txt></Card> : null}
          {error && d ? <Notice tone="warn" text={`${error} Showing the last data that loaded.`} /> : null}
          {!d && !error ? <><Skeleton h={300} r={16} /><Skeleton h={220} r={16} /></> : null}
          {d ? (
            <>
              {d.overridesError ? <Notice tone="warn" text="Temporary boosts could not be loaded (stored state unreadable): budgets still work." /> : null}
              <View style={{ gap: 6 }}>
                <Txt v="label">Budgets</Txt>
                <Txt v="small" color="muted">Caps are enforced live by the gateway. Each period is independent: a person is blocked when they reach any of them.</Txt>
              </View>
              <View style={{ flexDirection: wide ? 'row' : 'column', gap: 16 }}>
                {(['weekly', 'monthly'] as const).map((p) => (
                  <BudgetEditor key={p} kind="user" period={p} budget={d.user.budgets[p]} own={d.user.ownLimits[p]} defaultCents={d.orgDefaults[p]} subject={d.user.name} onSave={save(p)}
                    boost={includedBoost(d.user.budgets[p], d.overrides, p)} onCancelBoost={cancelBoost} style={wide ? { flex: 1, minWidth: 0 } : { alignSelf: 'stretch' }} />
                ))}
              </View>
              {d.user.budgets.daily.capCents !== null || d.user.budgets.daily.unlimited ? (
                <Card pad={14} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Chip label="Daily" color={t.muted} />
                  <Txt v="small" color="text2" style={{ flex: 1 }}>
                    Also enforced: {d.user.budgets.daily.unlimited ? 'unlimited per day' : `${usd(d.user.budgets.daily.capCents)} per day`} ({d.user.budgets.daily.source === 'user' ? 'personal' : 'company default'}), spent today {usd(d.user.budgets.daily.spendCents)}. Daily caps are managed with scripts/set-limit.sh.
                  </Txt>
                </Card>
              ) : null}

              <BoostCard d={d} onChanged={async () => { await reload(); onChanged(); }} />

              <Card style={{ gap: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Txt v="h3">Requests by model</Txt>
                  <Txt v="small" color="muted">{int(d.models.reduce((s, m) => s + m.requests, 0))} total</Txt>
                </View>
                <StackedBars buckets={d.buckets} series={series} bucketSeconds={d.bucketSeconds} />
                <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
              </Card>

              {d.models.length ? (
                <Card style={{ gap: 14 }}>
                  <Txt v="h3">Model mix</Txt>
                  <HBars rows={d.models.map((m) => ({ label: modelShort(m.model), value: m.requests, color: modelColor(t, m.model), right: `${int(m.requests)} · ${Math.round((m.ok / m.requests) * 100)}% ok${m.p50 ? ` · ${m.p50} ms` : ''}` }))} />
                </Card>
              ) : null}

              <Card style={{ gap: 4 }}>
                <Txt v="h3" style={{ marginBottom: 8 }}>Recent requests</Txt>
                {d.recent.length === 0 ? <Txt v="small" color="muted">No requests in this view.</Txt> : d.recent.slice(0, 12).map((r) => {
                  const o = outcomeInfo(t, r.outcome);
                  return (
                    <View key={r.id} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border, gap: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Chip label={o.label} color={o.color} />
                        <Txt v="small" style={{ flex: 1, minWidth: 90, fontFamily: font(600) }} numberOfLines={1}>{modelShort(r.model)}</Txt>
                        <Txt v="small" color="muted">{r.status} · {r.ms} ms</Txt>
                        <Txt v="small" color="muted" numberOfLines={1} style={{ textAlign: 'right' }}>{clock(r.ts)}</Txt>
                      </View>
                      {r.cause ? <Txt v="small" color={o.color}>{r.cause.replace(/_/g, ' ').toLowerCase()}</Txt> : null}
                      <Txt v="small" color="muted" selectable style={{ fontSize: 11 }}>{r.id}</Txt>
                    </View>
                  );
                })}
              </Card>

              <Card style={{ gap: 4 }}>
                <Txt v="h3" style={{ marginBottom: 8 }}>Budget history</Txt>
                {d.auditTruncated ? <Txt v="small" color="muted" style={{ marginBottom: 6 }}>Showing the most recent 500 changes. Older ones are not listed.</Txt> : null}
                {d.audit.length === 0 ? <Txt v="small" color="muted">No personal budget changes yet. Changes made here appear in this list.</Txt> : d.audit.map((e) => <AuditRow key={e.id} e={e} compact />)}
              </Card>
            </>
          ) : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
