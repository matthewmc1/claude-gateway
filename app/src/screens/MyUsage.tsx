import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { DataSel, DetailRes, Insight, Range, getUser, getUsers } from '../api';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { budgetState, font, modelColor, toneColor, useTheme } from '../theme';
import { Avatar, Card, Chip, CommandBox, Empty, ErrorState, Notice, Select, Skeleton, Txt, useTween } from '../ui';
import { Legend, Ring, StackedBars } from '../charts';
import { Icon } from '../icons';
import { outcomeInfo } from '../outcome';
import { ago, clock, int, modelShort, oneLine, pctUsedNum, usd } from '../format';
import { readStore, writeStore } from '../store';
import { categoryLabel, isCommand, isTelemetry, orderInsights, severityInfo } from '../logic/coach';
import { badgeText, primaryOverride } from '../logic/overrides';
import { pickDefaultUser } from '../logic/nav';

function RingCard({ d, period }: { d: DetailRes; period: 'weekly' | 'monthly' }) {
  const { t } = useTheme();
  const b = d.user.budgets[period];
  const st = budgetState(t, b.spendCents, b.capCents, b.unlimited);
  const shown = pctUsedNum(useTween(st.pct));
  const unit = period === 'weekly' ? 'week' : 'month';
  const boost = primaryOverride(d.overrides.filter((o) => o.period === period));
  return (
    <Card style={{ flexGrow: 1, flexBasis: 300, flexDirection: 'row', alignItems: 'center', gap: 18 }}>
      <Ring pct={st.pct} color={st.color} dashed={st.key === 'nocap' || st.key === 'unlimited'} size={88} stroke={9}>
        {st.key === 'unlimited' ? <Icon name="infinity" size={26} color={t.accent} /> : st.key === 'nocap' ? <Txt v="small" color="muted">—</Txt> : <Txt v="h3" style={{ fontFamily: font(700) }}>{shown}%</Txt>}
      </Ring>
      <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
        <Txt v="label">{period === 'weekly' ? 'This week' : 'This month'}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <Txt v="metric">{usd(b.spendCents)}</Txt>
          <Txt v="small" color="muted">{b.unlimited ? 'spent, no limit' : b.capCents === null ? 'spent, no cap' : `of ${usd(b.capCents)}`}</Txt>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Chip label={st.label} color={st.color} />
          {boost ? <Chip icon="bolt" label={badgeText(boost.o)} color={boost.o.status === 'active' ? t.good : t.accent} /> : null}
        </View>
        <Txt v="small" color="muted">{b.capCents !== null && !b.unlimited ? `${usd(Math.max(0, b.capCents - b.spendCents))} left this ${unit}` : ' '}</Txt>
      </View>
    </Card>
  );
}

function InsightCard({ i }: { i: Insight }) {
  const { t } = useTheme();
  const tele = isTelemetry(i);
  const sev = severityInfo(i.severity);
  const color = tele ? t.muted : toneColor(t, sev.tone);
  return (
    <View accessibilityLabel={`${tele ? 'Needs telemetry' : sev.label}: ${i.title}`}
      style={{ flexGrow: 1, flexBasis: 320, minWidth: 280, maxWidth: 560, backgroundColor: t.surface, borderRadius: 16, borderWidth: 1, borderColor: tele ? t.borderStrong : t.border, borderStyle: tele ? 'dashed' : 'solid', padding: 18, gap: 12, justifyContent: 'space-between' }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <Chip label={tele ? 'Needs telemetry' : sev.label} color={color} icon={tele ? 'info' : undefined} />
          <Txt v="label">{categoryLabel(i.category)}</Txt>
        </View>
        <Txt v="h3">{i.title}</Txt>
        <Txt v="small" color="text2" style={{ lineHeight: 18 }}>{i.description}</Txt>
        {i.impact ? <Txt v="small" color={t.accent} style={{ fontFamily: font(600) }}>{i.impact}</Txt> : null}
      </View>
      {i.action ? (isCommand(i.action) ? <CommandBox cmd={i.action} /> : (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingTop: 10, borderTopWidth: 1, borderTopColor: t.border }}>
          <Icon name="check" size={14} color={t.accent} />
          <Txt v="small" color="text2" style={{ flex: 1 }}><Txt v="small" style={{ fontFamily: font(600) }}>Try this: </Txt>{i.action}</Txt>
        </View>
      )) : null}
    </View>
  );
}

function Recent({ d }: { d: DetailRes }) {
  const { t } = useTheme();
  const rows = d.recent.slice(0, 10);
  return (
    <Card style={{ flexGrow: 1.4, flexBasis: 420, gap: 4 }}>
      <View style={{ marginBottom: 8, gap: 2 }}>
        <Txt v="h3">Last {rows.length || 10} requests</Txt>
        <Txt v="small" color="muted">What happened to the most recent requests. Failed ones show why.</Txt>
      </View>
      {rows.length === 0 ? <Txt v="small" color="muted">No requests yet. They appear here as soon as {d.user.name} uses Claude Code through the gateway.</Txt> : rows.map((r) => {
        const o = outcomeInfo(t, r.outcome);
        return (
          <View key={r.id} style={{ paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.border, gap: 5 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Chip label={o.label} color={o.color} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 90 }}>
                <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: modelColor(t, r.model) }} />
                <Txt v="small" style={{ fontFamily: font(600), flexShrink: 1 }} numberOfLines={1}>{modelShort(r.model)}</Txt>
                {r.lt ? <Chip label="Load test" color={t.muted} /> : null}
              </View>
              <Txt v="small" color="muted">{r.status} · {int(r.ms)} ms</Txt>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <Txt v="small" color="muted">{clock(r.ts)} · {ago(r.ts)}</Txt>
              {r.cause ? <Txt v="small" color={o.color}>{r.cause.replace(/_/g, ' ').toLowerCase()}</Txt> : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function ChangeModel() {
  const { t } = useTheme();
  const step = (n: string, title: string, cmd: string, hint: string) => (
    <View key={cmd} style={{ flexGrow: 1, flexBasis: 280, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Txt v="small" color={t.accent} style={{ fontFamily: font(700) }}>{n}</Txt></View>
        <Txt v="h3">{title}</Txt>
      </View>
      <CommandBox cmd={cmd} hint={hint} />
    </View>
  );
  return (
    <Card style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="terminal" size={18} color={t.accent} /><Txt v="h3">Change your model</Txt></View>
        <Txt v="small" color="muted" style={{ maxWidth: 700 }}>You start on your company's default model (see Models), which may be a lighter, cheaper model than you want for a hard task. Moving up is your choice: Sonnet is a step up, and Opus costs the most per request and uses your budget fastest. Run these in a terminal on your own machine, from the folder where you keep the setup script.</Txt>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
        {step('1', 'Step up to Opus', './claude-gateway-setup.sh upgrade', 'Switches to the upgrade model your admin chose. Your company policy may still decide the starting model of a new session.')}
        {step('2', 'Back to the company default', './claude-gateway-setup.sh downgrade', 'Undoes your own model choice. To pick by name instead: model sonnet, model opus or model haiku.')}
        {step('3', 'Set thinking effort', './claude-gateway-setup.sh effort high', 'low, medium, high or xhigh. More effort uses more budget.')}
        {step('4', 'Just this session', '/model opus', 'Type it inside Claude Code. It applies to the current session only; /effort high works the same way.')}
      </View>
    </Card>
  );
}

export function MyUsage({ range, data }: { range: Range; data: DataSel }) {
  const { t } = useTheme();
  const { admin } = useAuth();
  const users = useLoad(() => getUsers(range, data), [range, data], 60000);
  const [sel, setSel] = useState<string | null>(() => readStore('mypick'));
  const list = users.data?.users ?? [];
  const sub = pickDefaultUser(list, sel, admin?.email ?? null);
  const detail = useLoad(() => (sub ? getUser(sub, range, data) : Promise.resolve(null)), [sub, range, data], 30000);
  const d = detail.data && detail.data.user.sub === sub ? detail.data : null;
  const insights = useMemo(() => orderInsights(d?.coach.insights ?? []), [d]);
  const pick = (s: string) => { setSel(s); writeStore('mypick', s); };

  if (users.error && !users.data) return <Card><ErrorState title="Could not load people" message={users.error} onRetry={users.reload} /></Card>;
  if (!users.data) return <View style={{ gap: 16 }}><Card><Skeleton h={50} /></Card><View style={{ flexDirection: 'row', gap: 16 }}>{[0, 1].map((i) => <Card key={i} style={{ flex: 1 }}><Skeleton h={90} /></Card>)}</View><Card><Skeleton h={220} /></Card></View>;
  if (list.length === 0) return <Card><Empty icon="users" title="No one has used the gateway yet" hint="Once someone makes a request through the gateway, their usage and coaching tips appear here." /></Card>;
  const user = list.find((u) => u.sub === sub)!;
  const daily = d?.user.budgets.daily;
  const series = d ? d.series.models.map((m) => ({ key: m, label: modelShort(m), color: modelColor(t, m), values: d.series.values[m] })) : [];
  const total = d ? d.models.reduce((s, m) => s + m.requests, 0) : 0;

  return (
    <View style={{ gap: 22 }}>
      {users.data.usageConnected ? null : <Notice text="Request analytics aren't connected on this deployment, so the request list, chart and coaching tips that depend on them are empty. Budgets still work." />}
      <Card pad={16} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <Avatar name={user.name} seed={Math.max(0, list.findIndex((u) => u.sub === sub))} size={42} />
        <View style={{ gap: 4, flexGrow: 1, flexBasis: 240, maxWidth: 460 }}>
          <Txt v="label">Viewing usage for</Txt>
          <Select label="Choose a person" value={sub!} onChange={pick} options={list.map((u) => ({ value: u.sub, label: oneLine(u.email ? `${u.name} (${u.email})` : u.name) }))} />
        </View>
        {admin && user.email && admin.email.toLowerCase() === user.email.toLowerCase() ? <Chip label="You" color={t.accent} /> : null}
      </Card>

      {detail.error && !d ? <Card><ErrorState title="Could not load this person's usage" message={detail.error} onRetry={detail.reload} /></Card> : null}
      {!d && !detail.error ? <View style={{ gap: 16 }}><View style={{ flexDirection: 'row', gap: 16 }}>{[0, 1].map((i) => <Card key={i} style={{ flex: 1 }}><Skeleton h={90} /></Card>)}</View><Card><Skeleton h={200} /></Card></View> : null}

      {d ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            <RingCard d={d} period="weekly" />
            <RingCard d={d} period="monthly" />
          </View>
          {daily ? (
            <Card pad={14} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Chip label="Daily" color={t.muted} />
              <Txt v="small" color="text2" style={{ flex: 1 }}>
                {daily.unlimited ? 'No daily limit for you.' : daily.capCents !== null ? `Also enforced: ${usd(daily.capCents)} per day. Spent today ${usd(daily.spendCents)}.` : 'No daily limit is set.'} Daily limits are read-only here; admins manage them with scripts/set-limit.sh.
              </Txt>
            </Card>
          ) : null}

          <View style={{ gap: 12 }}>
            <View style={{ gap: 4 }}>
              <Txt v="h2">How to get more from your budget</Txt>
              {d.coach.summary ? <Txt v="small" color="muted">{d.coach.summary}</Txt> : null}
            </View>
            {insights.length === 0 ? <Card><Empty icon="check" title="No tips right now" hint="Tips appear here when the gateway has enough recent requests to look at." /></Card> : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>{insights.map((i) => <InsightCard key={i.id} i={i} />)}</View>
            )}
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
            <Recent d={d} />
            <Card style={{ flexGrow: 1, flexBasis: 360, gap: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Txt v="h3">Requests by model</Txt>
                <Txt v="small" color="muted">{int(total)} total</Txt>
              </View>
              <StackedBars buckets={d.buckets} series={series} bucketSeconds={d.bucketSeconds} />
              <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
            </Card>
          </View>
          <ChangeModel />
        </>
      ) : null}
    </View>
  );
}
