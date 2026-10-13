import React from 'react';
import { View } from 'react-native';
import { DataSel, ModelInfo, Range, getModels } from '../api';
import { useLoad } from '../hooks';
import { font, modelColor, toneColor, useTheme } from '../theme';
import { Card, Chip, CodeBlock, CommandBox, Empty, ErrorState, Notice, Skeleton, Txt } from '../ui';
import { BudgetBar, ShareBar } from '../charts';
import { Icon } from '../icons';
import { int, modelShort, pct } from '../format';
import { priceHint, tierInfo, usageShares } from '../logic/models';

const EXAMPLE = `{
  "alias": "sonnet",
  "id": "claude-sonnet-5-5",
  "label": "Sonnet 5.5",
  "tier": "default",            // default | upgrade | fast
  "description": "Everyday coding.",
  "enabled": true,
  "pricePerMTok": { "input": null, "output": null, "cacheRead": null, "cacheWrite": null }
}`;

function ModelCard({ m, isDefault, share }: { m: ModelInfo; isDefault: boolean; share: { requests: number; ok: number; share: number } | undefined }) {
  const { t } = useTheme();
  const tier = tierInfo(m.tier), color = modelColor(t, m.id), price = priceHint(m.pricePerMTok);
  const s = share ?? { requests: 0, ok: 0, share: 0 };
  return (
    <Card style={{ flexGrow: 1, flexBasis: 320, minWidth: 280, maxWidth: 520, gap: 14, opacity: m.enabled ? 1 : 0.6 }} pad={20}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: color + '24', borderWidth: 1, borderColor: color + '66', alignItems: 'center', justifyContent: 'center' }}><Icon name="layers" size={18} color={color} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="h2" numberOfLines={1}>{m.label}</Txt>
          <Txt v="small" color="muted" numberOfLines={1} selectable>{m.id} · alias {m.alias}</Txt>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Chip label={tier.label} color={toneColor(t, tier.tone)} />
        {isDefault ? <Chip icon="check" label="Starting model" color={t.good} /> : null}
        {!m.enabled ? <Chip label="Disabled" color={t.muted} /> : null}
      </View>
      <Txt v="body" color="text2">{m.description}</Txt>
      {price ? <View style={{ gap: 2 }}><Txt v="label">Price</Txt><Txt v="small" color="text2">{price}</Txt></View> : null}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Txt v="label">Share of requests</Txt>
          <Txt v="small" style={{ fontFamily: font(600) }}>{pct(s.share)}</Txt>
        </View>
        <BudgetBar pct={s.share} color={color} />
        <Txt v="small" color="muted">{s.requests ? `${int(s.requests)} requests · ${pct(s.ok / s.requests)} succeeded` : 'No requests in this range'}</Txt>
      </View>
    </Card>
  );
}

export function Models({ range, data }: { range: Range; data: DataSel }) {
  const { t } = useTheme();
  const { data: res, error, reload } = useLoad(() => getModels(range, data), [range, data]);
  if (error && !res) return <Card><ErrorState title="Could not load models" message={error} onRetry={reload} /></Card>;
  if (!res) return <View style={{ gap: 16, flexDirection: 'row', flexWrap: 'wrap' }}>{[0, 1, 2].map((i) => <Card key={i} style={{ flexGrow: 1, flexBasis: 320 }}><Skeleton h={220} /></Card>)}</View>;
  const { total, by, other } = usageShares(res.models, res.usage);
  const defModel = res.models.find((m) => m.alias === res.default);
  const parts = [...res.models.map((m) => ({ label: m.label, value: by.get(m.id)?.requests ?? 0, color: modelColor(t, m.id) })), ...(other.length ? [{ label: 'Other', value: other.reduce((s, o) => s + o.requests, 0), color: t.muted }] : [])];
  return (
    <View style={{ gap: 24 }}>
      {total === 0 ? <Notice text="No model traffic to show for this range. Usage analytics may not be connected on this deployment; the models below are still the ones configured." /> : null}
      {res.models.length === 0 ? <Card><Empty icon="layers" title="No models configured" hint="Add models to config/models.json and apply it. The panel below shows how." /></Card> : (
        <>
          {total > 0 ? (
            <Card style={{ gap: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <Txt v="h3">Traffic by model</Txt>
                <Txt v="small" color="muted">{int(total)} requests · last {range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}</Txt>
              </View>
              <ShareBar parts={parts} />
            </Card>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {res.models.map((m) => <ModelCard key={m.id} m={m} isDefault={m.alias === res.default} share={by.get(m.id)} />)}
          </View>
          {defModel ? <Txt v="small" color="muted">Everyone starts on {defModel.label}. Moving up to another model is an explicit choice each person makes; the My usage page shows how.</Txt> : null}
        </>
      )}
      {other.length ? (
        <Card style={{ gap: 10 }}>
          <Txt v="h3">Other traffic</Txt>
          <Txt v="small" color="muted">Requests for models that are not in the configured list (older versions, or requests that named no model).</Txt>
          {other.map((o) => <View key={o.model} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Txt v="small" color="text2" numberOfLines={1} style={{ flex: 1 }}>{o.model === '(none)' ? 'No model named' : modelShort(o.model)}</Txt><Txt v="small" style={{ fontFamily: font(600) }}>{int(o.requests)} · {pct(o.share)}</Txt></View>)}
        </Card>
      ) : null}

      <Card style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="plus" size={18} color={t.accent} />
          <Txt v="h3">How to add a model</Txt>
        </View>
        <Txt v="small" color="muted" style={{ maxWidth: 680 }}>One file lists every model people can use. The gateway policy, the aliases pinned on every engineer's machine and this page all follow it, so there is only one place to edit.</Txt>
        <View style={{ gap: 6 }}><Txt v="label">1. Add an entry to config/models.json</Txt><CodeBlock text={EXAMPLE} /></View>
        <View style={{ gap: 6 }}>
          <Txt v="label">2. Apply it</Txt>
          <CommandBox cmd="terraform apply" hint="Run from the terraform directory. Fill in pricePerMTok (USD per million tokens, from your Vertex price list) to show price hints here; leave null to hide them." />
        </View>
      </Card>
    </View>
  );
}
