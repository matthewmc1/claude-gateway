import React, { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { DataSel, Period, Range, UserRow, getUsers } from '../api';
import { useLoad } from '../hooks';
import { budgetState, font, modelColor, pointer, useTheme } from '../theme';
import { Avatar, Card, Chip, Empty, Notice, Segmented, Skeleton, Txt, useTween } from '../ui';
import { Ring, Sparkline } from '../charts';
import { Icon } from '../icons';
import { ago, int, modelShort, pct, usd } from '../format';

type Sort = 'spend' | 'requests' | 'used' | 'name';

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card style={{ flex: 1, minWidth: 150, gap: 6 }} pad={18}>
      <Txt v="label">{label}</Txt>
      <Txt v="metric" color={color}>{value}</Txt>
      {sub ? <Txt v="small" color="muted">{sub}</Txt> : null}
    </Card>
  );
}

function UserCard({ u, index, period, onOpen }: { u: UserRow; index: number; period: Period; onOpen: () => void }) {
  const { t } = useTheme();
  const b = u.budgets[period];
  const st = budgetState(t, b.spendCents, b.capCents, b.unlimited);
  const pctShown = Math.round(useTween(st.pct) * 100);
  const unit = period === 'weekly' ? 'week' : 'month';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${u.name}`} onPress={onOpen}
      style={(s: any) => [{ flexGrow: 1, flexBasis: 340, minWidth: 300, maxWidth: 560 }, pointer]}>
      {(s: any) => (
        <Card pad={20} style={[{ gap: 18 }, s.hovered ? { borderColor: t.accent, transform: [{ translateY: -2 }] } : null, { transitionProperty: 'transform, border-color', transitionDuration: '140ms' } as any, s.hovered ? ({ boxShadow: t.shadow } as any) : null]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={u.name} seed={index} />
            <View style={{ flex: 1 }}>
              <Txt v="h3" numberOfLines={1}>{u.name}</Txt>
              <Txt v="small" color="muted" numberOfLines={1}>{u.email ?? 'not seen yet'}</Txt>
            </View>
            <Icon name="chevron" size={18} color={t.muted} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
            <Ring pct={st.pct} color={st.color} dashed={st.key === 'nocap' || st.key === 'unlimited'} size={82}>
              {st.key === 'unlimited' ? <Icon name="infinity" size={24} color={t.accent} /> : st.key === 'nocap' ? <Txt v="small" color="muted">—</Txt> : <Txt v="h3" style={{ fontFamily: font(700) }}>{pctShown}%</Txt>}
            </Ring>
            <View style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <Txt v="metric">{usd(b.spendCents)}</Txt>
                <Txt v="small" color="muted">{b.unlimited ? `this ${unit}, unlimited` : b.capCents === null ? `this ${unit}, no cap` : `of ${usd(b.capCents)} / ${unit}`}</Txt>
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Chip label={st.label} color={st.color} />
                {b.source === 'user' || b.unlimited ? <Chip label="Personal cap" color={t.accent} /> : null}
              </View>
            </View>
          </View>
          <View style={{ height: 1, backgroundColor: t.border }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Sparkline values={u.spark} color={t.accent} width={130} height={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="h3">{int(u.requests)} <Txt v="small" color="muted">requests</Txt></Txt>
              <Txt v="small" color="muted">{u.requests ? `${pct(u.ok / u.requests)} succeeded` : 'no activity'} · {ago(u.lastSeen)}</Txt>
            </View>
          </View>
          {u.models.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {u.models.slice(0, 4).map((m) => (
                <View key={m} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: modelColor(t, m) }} />
                  <Txt v="small" color="text2">{modelShort(m)}</Txt>
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      )}
    </Pressable>
  );
}

export function People({ range, data, period, onOpen }: { range: Range; data: DataSel; period: Period; onOpen: (sub: string) => void }) {
  const { t } = useTheme();
  const { data: res, error, loading } = useLoad(() => getUsers(range, data), [range, data]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('spend');
  const users = useMemo(() => {
    const list = (res?.users ?? []).filter((u) => (u.name + ' ' + (u.email ?? '')).toLowerCase().includes(q.toLowerCase()));
    const used = (u: UserRow) => { const b = u.budgets[period]; return b.capCents ? b.spendCents / b.capCents : -1; };
    const by: Record<Sort, (a: UserRow, b: UserRow) => number> = {
      spend: (a, b) => b.budgets[period].spendCents - a.budgets[period].spendCents || b.requests - a.requests,
      requests: (a, b) => b.requests - a.requests, used: (a, b) => used(b) - used(a), name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [res, q, sort, period]);

  if (error && !res) return <Card><Empty icon="alert" title="Could not load people" hint={error} /></Card>;
  if (!res) return <View style={{ gap: 16 }}><View style={{ flexDirection: 'row', gap: 16 }}>{[0, 1, 2, 3].map((i) => <Card key={i} style={{ flex: 1 }}><Skeleton h={60} /></Card>)}</View><Card><Skeleton h={260} /></Card></View>;

  const all = res.users;
  const totalSpend = all.reduce((s, u) => s + u.budgets[period].spendCents, 0);
  const attention = all.filter((u) => ['near', 'over'].includes(budgetState(t, u.budgets[period].spendCents, u.budgets[period].capCents, u.budgets[period].unlimited).key)).length;
  const reqs = all.reduce((s, u) => s + u.requests, 0);
  const unit = period === 'weekly' ? 'week' : 'month';
  return (
    <View style={{ gap: 20 }}>
      {res.usageConnected ? null : <Notice text="Request analytics aren't connected on this deployment, so request counts and charts are empty. Budgets and caps work normally. People appear here once they have spend or a personal cap." />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        <Kpi label="People" value={int(all.length)} sub="seen through the gateway" />
        <Kpi label={`Spent this ${unit}`} value={usd(totalSpend)} sub="gateway list-price estimate" />
        <Kpi label="Requests" value={int(reqs)} sub={`last ${range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}`} />
        <Kpi label="Need attention" value={int(attention)} sub="near or at their limit" color={attention ? t.serious : undefined} />
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <View style={{ flexGrow: 1, flexBasis: 260, maxWidth: 380, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingHorizontal: 12, height: 40 }}>
          <Icon name="search" size={16} color={t.muted} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search people" placeholderTextColor={t.muted} accessibilityLabel="Search people"
            style={[{ flex: 1, fontFamily: font(500), fontSize: 14, color: t.text, padding: 0 }, { outlineStyle: 'none' } as any]} />
          {q ? <Pressable accessibilityLabel="Clear search" onPress={() => setQ('')} style={pointer}><Icon name="x" size={15} color={t.muted} /></Pressable> : null}
        </View>
        <View style={{ flex: 1 }} />
        <Txt v="small" color="muted">Sort by</Txt>
        <Segmented small value={sort} onChange={setSort} options={[{ value: 'spend', label: 'Spend' }, { value: 'used', label: '% used' }, { value: 'requests', label: 'Requests' }, { value: 'name', label: 'Name' }]} />
      </View>

      {users.length === 0 ? <Card><Empty title={q ? 'No one matches that search' : 'No one has used the gateway yet'} hint={q ? undefined : 'People appear here after their first request through the gateway.'} /></Card> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, opacity: loading ? 0.85 : 1 }}>
          {users.map((u) => <UserCard key={u.sub} u={u} index={all.findIndex((x) => x.sub === u.sub)} period={period} onOpen={() => onOpen(u.sub)} />)}
        </View>
      )}
    </View>
  );
}
