import React, { useState } from 'react';
import { View } from 'react-native';
import { AuditEvent, getAudit, getOverrides } from '../api';
import { useLoad } from '../hooks';
import { font, useTheme } from '../theme';
import { Card, Chip, Empty, ErrorState, Notice, Segmented, Skeleton, Txt } from '../ui';
import { OverrideRow, useRetry } from './overrides-ui';
import { isLive } from '../logic/overrides';
import { Icon, IconName } from '../icons';
import { ago, clock, usd } from '../format';

const KIND: Record<string, { label: string; icon: IconName; key: 'good' | 'warn' | 'crit' | 'accent' | 'muted' }> = {
  created: { label: 'Created', icon: 'plus', key: 'accent' }, raised: { label: 'Raised', icon: 'chevron', key: 'good' },
  lowered: { label: 'Lowered', icon: 'minus', key: 'warn' }, removed: { label: 'Removed', icon: 'x', key: 'crit' },
  unlimited: { label: 'Unlimited', icon: 'infinity', key: 'accent' }, unchanged: { label: 'Unchanged', icon: 'check', key: 'muted' }, changed: { label: 'Changed', icon: 'check', key: 'muted' },
};

export function AuditRow({ e, compact }: { e: AuditEvent; compact?: boolean }) {
  const { t } = useTheme();
  const k = KIND[e.kind] || KIND.changed, color = t[k.key];
  const amt = (c: number | null) => (c === null ? 'no cap' : usd(c));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: compact ? 10 : 14, borderTopWidth: 1, borderTopColor: t.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: color + '22', alignItems: 'center', justifyContent: 'center' }}>
        <View style={e.kind === 'raised' ? { transform: [{ rotate: '-90deg' }] } : undefined}><Icon name={k.icon} size={16} color={color} stroke={2.3} /></View>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="body">
          <Txt v="body" style={{ fontFamily: font(600) }}>{e.who}</Txt> · {e.period} budget {e.kind === 'created' ? `set to ${amt(e.toCents)}` : e.kind === 'removed' ? `removed (was ${amt(e.fromCents)})` : e.kind === 'unlimited' ? 'set to unlimited' : `${amt(e.fromCents)} → ${amt(e.toCents)}`}
        </Txt>
        <Txt v="small" color="muted">by {e.actor} · {clock(e.at)} ({ago(e.at)})</Txt>
      </View>
      <Chip label={k.label} color={color} />
    </View>
  );
}

type OvFilter = 'all' | 'live' | 'finished';
function Overrides() {
  const { t } = useTheme();
  const { data, error, reload } = useLoad(() => getOverrides(), [], 20000);
  const [f, setF] = useState<OvFilter>('all');
  const [err, setErr] = useState<string | null>(null);
  const { onRetry, retryBusy } = useRetry(async () => { setErr(null); await reload(); }, setErr);
  const rows = (data?.overrides ?? []).filter((o) => f === 'all' || (f === 'live' ? isLive(o) : !isLive(o)));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
          <Txt v="h2">Temporary boosts</Txt>
          <Txt v="small" color="muted">Caps raised for a limited time, with who granted them and why. They revert automatically when the window ends.</Txt>
        </View>
        <Segmented small value={f} onChange={setF} options={[{ value: 'all', label: 'All' }, { value: 'live', label: 'Live' }, { value: 'finished', label: 'Finished' }]} />
      </View>
      {data?.overridesError ? <Notice tone="warn" text="Temporary boosts could not be loaded (stored state unreadable): budgets still work." /> : null}
      <Card pad={8} style={{ paddingHorizontal: 20 }}>
        {error && !data ? <ErrorState title="Could not load boosts" message={error} onRetry={reload} />
          : !data ? <View style={{ padding: 12 }}><Skeleton h={120} /></View>
          : rows.length === 0 ? <Empty icon="bolt" title={f === 'all' ? 'No boosts yet' : 'Nothing here'} hint={f === 'all' ? 'Grant one from a person\'s page when someone needs more budget for a while.' : undefined} />
          : rows.map((o, i) => <OverrideRow key={o.id} o={o} showWho first={i === 0} onRetry={onRetry} retryBusy={retryBusy} />)}
      </Card>
      {err ? <Txt v="small" color={t.crit} accessibilityRole="alert">{err}</Txt> : null}
    </View>
  );
}

export function Activity() {
  const { t } = useTheme();
  const { data, error, reload } = useLoad(getAudit, [], 20000);
  const [f, setF] = useState<'all' | 'up' | 'down'>('all');
  const rows = (data?.events ?? []).filter((e) => f === 'all' || (f === 'up' ? ['raised', 'created', 'unlimited'].includes(e.kind) : ['lowered', 'removed'].includes(e.kind)));
  return (
    <View style={{ gap: 28 }}>
      <Overrides />
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
            <Txt v="h2">Budget changes</Txt>
            <Txt v="small" color="muted">Every change to a spend cap, from the gateway's own audit log. It records who made the change and the before and after amounts.</Txt>
          </View>
          <Segmented small value={f} onChange={setF} options={[{ value: 'all', label: 'All' }, { value: 'up', label: 'Increases' }, { value: 'down', label: 'Decreases' }]} />
        </View>
        <Card pad={8} style={{ paddingHorizontal: 20 }}>
          {error && !data ? <ErrorState title="Could not load the audit trail" message={error} onRetry={reload} />
            : !data ? <View style={{ padding: 12 }}><Skeleton h={240} /></View>
            : rows.length === 0 ? <Empty icon="activity" title="Nothing here yet" hint="Budget changes appear here as soon as they are made." />
            : rows.map((e, i) => <View key={e.id} style={i === 0 ? { marginTop: -1 } : undefined}><AuditRow e={e} /></View>)}
        </Card>
      </View>
    </View>
  );
}
