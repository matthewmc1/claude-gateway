import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Override, isCancelled, isMissing, retryOverride } from '../api';
import { font, useTheme, toneColor } from '../theme';
import { useAuth } from '../auth';
import { useNow } from '../hooks';
import { Button, Chip, Txt, useToast } from '../ui';
import { Icon } from '../icons';
import { clock, oneLine, usd } from '../format';
import { canRetry, isLive, overdueMs, remaining, retryOutcome, startLateMs, statusDisplay } from '../logic/overrides';

// Once a backend answers 404 to POST /api/overrides/:id/retry we stop offering the button for the rest of the session.
let retryMissing = false;
/** Retry handler for failed boosts. `onRetry` is undefined (so the row shows no button) when the backend has no retry endpoint. */
export function useRetry(onChanged: () => void | Promise<void>, onError: (m: string) => void) {
  const { runAdmin } = useAuth(); const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [missing, setMissing] = useState(retryMissing);
  const retry = useCallback(async (o: Override) => {
    setBusyId(o.id);
    try {
      const r = await runAdmin('Sign in as an admin to retry this boost.', () => retryOverride(o.id));
      const out = retryOutcome(r); toast(out.text, out.kind); await onChanged();
    } catch (e: any) {
      if (isCancelled(e)) return;
      if (isMissing(e)) { retryMissing = true; setMissing(true); return; }
      onError(e.message || 'Could not retry the boost');
    } finally { setBusyId(null); }
  }, [runAdmin, toast, onChanged, onError]);
  return { onRetry: missing ? undefined : retry, retryBusy: busyId };
}

/** One temporary boost: who, how much, why, when, and its status. Live ones can be cancelled; failed ones retried. */
export function OverrideRow({ o, showWho, onCancel, onRetry, busy, retryBusy, first }: {
  o: Override; showWho?: boolean; onCancel?: (o: Override) => void; onRetry?: (o: Override) => void; busy?: boolean; retryBusy?: string | null; first?: boolean;
}) {
  const { t } = useTheme();
  const { admin } = useAuth();
  const now = useNow(30000);
  const [sure, setSure] = useState(false);
  const st = statusDisplay(o, now), color = toneColor(t, st.tone);
  const left = remaining(o, now);
  const warn = overdueMs(o, now) !== null || startLateMs(o, now) !== null;
  const note = o.note ? oneLine(o.note) : '';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14, borderTopWidth: first ? 0 : 1, borderTopColor: t.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: color + '22', alignItems: 'center', justifyContent: 'center' }}><Icon name={warn || o.status === 'failed' ? 'alert' : 'bolt'} size={16} color={color} stroke={2.2} /></View>
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <Txt v="body">
          {showWho ? <Txt v="body" style={{ fontFamily: font(600) }}>{o.name} · </Txt> : null}
          <Txt v="body" style={{ fontFamily: font(600) }}>{usd(o.extraCents, { signed: true })}</Txt> {o.period} budget
          {o.baseCents !== null && o.targetCents !== null ? <Txt v="small" color="muted">  ({usd(o.baseCents)} → {usd(o.targetCents)})</Txt> : null}
        </Txt>
        <Txt v="small" color="text2">{oneLine(o.reason)}</Txt>
        <Txt v="small" color="muted">{clock(o.startsAt)} → {clock(o.endsAt)} · by {o.createdBy}</Txt>
        {o.creatorRemoved && isLive(o) ? <View style={{ alignSelf: 'flex-start' }}><Chip icon="alert" label="Creator removed, runs to its end" color={t.serious} /></View> : null}
        {warn && left ? <Txt v="small" color={color} style={{ fontFamily: font(600) }} accessibilityRole="alert">{left}</Txt> : null}
        {note ? <Txt v="small" color={o.status === 'failed' ? t.crit : t.serious}>{note}</Txt> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        <Chip label={st.label} color={color} />
        {left && !warn ? <Txt v="small" color="muted">{left}</Txt> : null}
        {onRetry && canRetry(o, now) ? <Button small kind="primary" label="Retry" icon={admin ? 'refresh' : 'lock'} busy={retryBusy === o.id} onPress={() => onRetry(o)} /> : null}
        {onCancel && isLive(o) ? (
          sure ? (
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button small kind="danger" label="Cancel boost" busy={busy} onPress={() => { onCancel(o); setSure(false); }} />
              <Button small kind="ghost" label="Keep" onPress={() => setSure(false)} />
            </View>
          ) : <Button small label="Cancel" icon={admin ? undefined : 'lock'} onPress={() => setSure(true)} />
        ) : null}
      </View>
    </View>
  );
}
