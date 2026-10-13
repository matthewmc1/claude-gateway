import React, { useMemo } from 'react';
import { View } from 'react-native';
import { BudgetPayload, DataSel, Period, Range, getCompany, getUsers, setOrgBudget } from '../api';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { modelColor, useTheme, userColor } from '../theme';
import { Button, Card, Chip, ErrorState, Notice, Skeleton, Txt, useToast } from '../ui';
import { Icon } from '../icons';
import { BudgetBar, HBars, Legend, ShareBar, StackedBars } from '../charts';
import { BudgetEditor } from '../BudgetEditor';
import { int, modelShort, pct, usd } from '../format';
import { peopleWithPersonalCaps } from '../logic/impact';

const SECONDS = { '24h': 3600, '7d': 6 * 3600, '30d': 86400 };

export function Company({ range, data, onOpenActivity }: { range: Range; data: DataSel; onOpenActivity: () => void }) {
  const { t } = useTheme();
  const toast = useToast();
  const { runAdmin } = useAuth();
  const { data: c, error, reload } = useLoad(() => getCompany(range, data), [range, data]);
  // Everyone the app knows, to show how many people rely on the company default (and so how many a change touches).
  const { data: ppl, error: pplError, reload: reloadPeople } = useLoad(() => getUsers(range, data), [range, data]);
  const people = ppl ? ppl.users : pplError ? null : undefined;
  const series = useMemo(() => (c ? c.users.map((u, i) => ({ key: u.sub, label: u.email ?? u.sub.slice(0, 8), color: userColor(t, i), values: c.series[u.sub] })) : []), [c, t]);
  if (error && !c) return <Card><ErrorState title="Could not load company data" message={error} onRetry={reload} /></Card>;
  if (!c) return <View style={{ gap: 16 }}><Card><Skeleton h={300} /></Card><Card><Skeleton h={220} /></Card></View>;

  const save = (period: Period) => async (p: BudgetPayload) => {
    await runAdmin('Sign in as an admin to change the company default.', () => setOrgBudget(p)); await Promise.all([reload(), reloadPeople()]);
    toast(p.action === 'inherit' ? `Removed the company ${period} default` : `Company ${period} default set to ${usd(Math.round((p.usd ?? 0) * 100))} per person`);
  };
  // People, not limit rows: one person with a weekly and a monthly cap is one person. Falls back to an honest "limits" count.
  const withCaps = c.usersWithOverrides ?? (ppl ? peopleWithPersonalCaps(ppl.users) : null);
  const personal = withCaps !== null ? `${withCaps} ${withCaps === 1 ? 'person has' : 'people have'} a personal cap` : `${c.userOverrides} personal limit${c.userOverrides === 1 ? '' : 's'}`;
  const T = c.totals, success = T.requests ? T.ok / T.requests : 0;
  return (
    <View style={{ gap: 24 }}>
      {error ? <Notice tone="warn" text={`${error} Showing the last data that loaded.`} /> : null}
      {c.usageConnected ? null : <Notice text="Request analytics aren't connected on this deployment, so usage charts are empty. Budgets, defaults and exposure still work." />}
      {c.overridesError ? <Notice tone="warn" text="Temporary boosts could not be loaded (stored state unreadable): budgets still work." /> : null}
      <View style={{ gap: 6 }}>
        <Txt v="h2">Company default budgets</Txt>
        <Txt v="small" color="muted" style={{ maxWidth: 680 }}>Each person gets this cap every week or month unless you give them their own on the People page. It is a per-person default, not a pool shared by the team.</Txt>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        {(['weekly', 'monthly'] as const).map((p) => <BudgetEditor key={p} kind="org" period={p} own={c.org[p]} subject="everyone" onSave={save(p)} people={people} style={{ flexGrow: 1, flexBasis: 320, maxWidth: '100%' }} />)}
      </View>

      <Card style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Txt v="h3">Exposure if everyone reaches their cap</Txt>
          <Txt v="small" color="muted">{c.seats} people · {personal}</Txt>
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

      <Card pad={18} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="bolt" size={18} color={t.accent} /></View>
        <View style={{ flex: 1, minWidth: 220, gap: 4 }}>
          <Txt v="h3">Temporary boosts</Txt>
          <Txt v="small" color="muted">{c.overrides.active + c.overrides.scheduled === 0 ? 'No boosts are running or planned. Grant one from a person\'s page; it reverts automatically.' : 'Caps raised for a while for on-call, launches or incidents. Each one reverts automatically when its window ends.'}</Txt>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {c.overridesError ? <Chip label="Boosts unavailable" color={t.warn} icon="alert" /> : <>
          <Chip label={`${c.overrides.active} active`} color={c.overrides.active ? t.good : t.muted} />
          <Chip label={`${c.overrides.scheduled} scheduled`} color={c.overrides.scheduled ? t.accent : t.muted} /></>}
          {!c.overridesError && c.overrides.overdue ? <Chip icon="alert" label={`${c.overrides.overdue} overdue`} color={t.crit} /> : null}
        </View>
        <Button small label="View in Activity" icon="chevron" onPress={onOpenActivity} />
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
