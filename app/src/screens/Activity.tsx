import React, { useState } from 'react';
import { View } from 'react-native';
import { AuditEvent, getAudit } from '../api';
import { useLoad } from '../hooks';
import { font, useTheme } from '../theme';
import { Card, Chip, Empty, Segmented, Skeleton, Txt } from '../ui';
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
        <Txt v="body" numberOfLines={2}>
          <Txt v="body" style={{ fontFamily: font(600) }}>{e.who}</Txt> · {e.period} budget {e.kind === 'created' ? `set to ${amt(e.toCents)}` : e.kind === 'removed' ? `removed (was ${amt(e.fromCents)})` : e.kind === 'unlimited' ? 'set to unlimited' : `${amt(e.fromCents)} → ${amt(e.toCents)}`}
        </Txt>
        <Txt v="small" color="muted">by {e.actor} · {clock(e.at)} ({ago(e.at)})</Txt>
      </View>
      <Chip label={k.label} color={color} />
    </View>
  );
}

export function Activity() {
  const { t } = useTheme();
  const { data, error } = useLoad(getAudit, [], 20000);
  const [f, setF] = useState<'all' | 'up' | 'down'>('all');
  if (error && !data) return <Card><Empty icon="alert" title="Could not load the audit trail" hint={error} /></Card>;
  if (!data) return <Card><Skeleton h={240} /></Card>;
  const rows = data.events.filter((e) => f === 'all' || (f === 'up' ? ['raised', 'created', 'unlimited'].includes(e.kind) : ['lowered', 'removed'].includes(e.kind)));
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <Txt v="small" color="muted" style={{ flex: 1, minWidth: 240 }}>Every change to a spend cap, from the gateway's own audit log. It records who made the change and the before and after amounts, and cannot be edited.</Txt>
        <Segmented small value={f} onChange={setF} options={[{ value: 'all', label: 'All' }, { value: 'up', label: 'Increases' }, { value: 'down', label: 'Decreases' }]} />
      </View>
      <Card pad={8} style={{ paddingHorizontal: 20 }}>
        {rows.length === 0 ? <Empty icon="activity" title="Nothing here yet" hint="Budget changes appear here as soon as they are made." /> : rows.map((e, i) => <View key={e.id} style={i === 0 ? { marginTop: -1 } : undefined}><AuditRow e={e} /></View>)}
      </Card>
    </View>
  );
}
