import React, { useMemo } from 'react';
import { View } from 'react-native';
import { BudgetPayload, DataSel, Period, Range, getCompany, setOrgBudget } from '../api';
import { useLoad } from '../hooks';
import { modelColor, useTheme, userColor } from '../theme';
import { Card, Chip, Empty, Notice, Skeleton, Txt, useToast } from '../ui';
import { BudgetBar, HBars, Legend, ShareBar, StackedBars } from '../charts';
import { BudgetEditor } from '../BudgetEditor';
import { int, modelShort, pct, usd } from '../format';

const SECONDS = { '24h': 3600, '7d': 6 * 3600, '30d': 86400 };

export function Company({ range, data }: { range: Range; data: DataSel }) {
  const { t } = useTheme();
  const toast = useToast();
  const { data: c, error, reload } = useLoad(() => getCompany(range, data), [range, data]);
  const series = useMemo(() => (c ? c.users.map((u, i) => ({ key: u.sub, label: u.email ?? u.sub.slice(0, 8), color: userColor(t, i), values: c.series[u.sub] })) : []), [c, t]);
  if (error && !c) return <Card><Empty icon="alert" title="Could not load company data" hint={error} /></Card>;
  if (!c) return <View style={{ gap: 16 }}><Card><Skeleton h={300} /></Card><Card><Skeleton h={220} /></Card></View>;

  const save = (period: Period) => async (p: BudgetPayload) => {
    await setOrgBudget(p); await reload();
    toast(p.action === 'inherit' ? `Removed the company ${period} default` : `Company ${period} default set to ${usd(Math.round((p.usd ?? 0) * 100))} per person`);
  };
  const T = c.totals, success = T.requests ? T.ok / T.requests : 0;
  return (
    <View style={{ gap: 24 }}>
      {c.usageConnected ? null : <Notice text="Request analytics aren't connected on this deployment, so usage charts are empty. Budgets, defaults and exposure still work." />}
      <View style={{ gap: 6 }}>
        <Txt v="h2">Company default budgets</Txt>
        <Txt v="small" color="muted" style={{ maxWidth: 680 }}>Each person gets this cap every week or month unless you give them their own on the People page. It is a per-person default, not a pool shared by the team.</Txt>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        {(['weekly', 'monthly'] as const).map((p) => <BudgetEditor key={p} kind="org" period={p} own={c.org[p]} subject="everyone" onSave={save(p)} />)}
      </View>

      <Card style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Txt v="h3">Exposure if everyone reaches their cap</Txt>
          <Txt v="small" color="muted">{c.seats} people · {c.userOverrides} personal override{c.userOverrides === 1 ? '' : 's'}</Txt>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 24 }}>
          {(['weekly', 'monthly'] as const).map((p) => {
            const s = c.spend[p]; const used = s.committedCents ? s.spendCents / s.committedCents : 0;
            return (
              <View key={p} style={{ flex: 1, minWidth: 260, gap: 8 }}>
                <Txt v="label">{p === 'weekly' ? 'This week' : 'This month'}</Txt>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                  <Txt v="metric">{usd(s.spendCents)}</Txt>
                  <Txt v="body" color="muted">{s.committedCents ? `spent of ${usd(s.committedCents)} committed` : `spent, no ${p === 'weekly' ? 'weekly' : 'monthly'} caps set`}</Txt>
                </View>
                {s.committedCents ? <BudgetBar pct={used} color={used >= 1 ? t.crit : used >= 0.85 ? t.serious : used >= 0.6 ? t.warn : t.accent} /> : null}
                {s.uncappedUsers ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Chip label={`${s.uncappedUsers} uncapped`} color={t.warn} /><Txt v="small" color="muted">No limit applies to them, so their exposure is unbounded.</Txt></View> : null}
              </View>
            );
          })}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        {[
          ['Requests', int(T.requests), undefined], ['Success rate', T.requests ? pct(success) : '—', undefined],
          ['Active people', int(T.users), undefined], ['Blocked by cap', int(T.blocked), T.blocked ? t.serious : undefined],
        ].map(([l, v, col]) => <Card key={l as string} pad={18} style={{ flex: 1, minWidth: 140, gap: 6 }}><Txt v="label">{l as string}</Txt><Txt v="metric" color={col as string | undefined}>{v as string}</Txt></Card>)}
      </View>

      <Card style={{ gap: 14 }}>
        <Txt v="h3">Requests by person</Txt>
        <StackedBars buckets={c.buckets} series={series} bucketSeconds={SECONDS[range]} height={220} />
        <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      </Card>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        <Card style={{ flex: 1, minWidth: 320, gap: 14 }}>
          <Txt v="h3">Models</Txt>
          {c.models.length ? <HBars rows={c.models.map((m) => ({ label: modelShort(m.model), value: m.requests, color: modelColor(t, m.model) }))} /> : <Txt v="small" color="muted">No requests yet.</Txt>}
        </Card>
        <Card style={{ flex: 1, minWidth: 320, gap: 14 }}>
          <Txt v="h3">Outcomes</Txt>
          <ShareBar parts={[
            { label: 'OK', value: T.ok, color: t.good }, { label: 'Rejected', value: T.rejected, color: t.warn },
            { label: 'Spend cap', value: T.blocked, color: t.serious }, { label: 'Provider error', value: T.upstream_errors, color: t.crit },
          ]} />
        </Card>
      </View>
    </View>
  );
}
