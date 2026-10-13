import React, { useState } from 'react';
import { LayoutChangeEvent, Pressable, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { font, useTheme } from './theme';
import { Txt, useTween } from './ui';
import { bucketLabel, int } from './format';

// ---------- ring gauge ----------
export function Ring({ pct, color, size = 76, stroke = 8, dashed, children }: { pct: number; color: string; size?: number; stroke?: number; dashed?: boolean; children?: React.ReactNode }) {
  const { t } = useTheme();
  const v = useTween(Math.min(1, Math.max(0, pct)));
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.track} strokeWidth={stroke} fill="none" strokeDasharray={dashed ? '3 6' : undefined} strokeLinecap="round" />
        {!dashed && v > 0.002 && (
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </Svg>
      {children}
    </View>
  );
}

// ---------- sparkline ----------
export function Sparkline({ values, color, width = 120, height = 36 }: { values: number[]; color: string; width?: number; height?: number }) {
  const { t } = useTheme();
  const max = Math.max(...values, 1), n = values.length;
  const pad = 3, x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(1, n - 1), y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const flat = values.every((v) => v === 0);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`;
  const id = 'g' + color.replace('#', '');
  return (
    <Svg width={width} height={height}>
      <Defs><LinearGradient id={id} x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={color} stopOpacity={0.35} /><Stop offset="1" stopColor={color} stopOpacity={0} /></LinearGradient></Defs>
      {flat ? <Line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke={t.borderStrong} strokeWidth={2} strokeLinecap="round" />
        : (<><Path d={area} fill={`url(#${id})`} /><Path d={line} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={x(n - 1)} cy={y(values[n - 1])} r={3.2} fill={color} stroke={t.surface} strokeWidth={2} /></>)}
    </Svg>
  );
}

// ---------- budget progress bar ----------
export function BudgetBar({ pct, color, height = 8 }: { pct: number; color: string; height?: number }) {
  const { t } = useTheme();
  const v = useTween(Math.min(1, Math.max(0, pct)));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: t.track, overflow: 'hidden' }}>
      <View style={{ width: `${v * 100}%`, height: '100%', borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

// ---------- stacked bars with hover tooltip ----------
export type Series = { key: string; label: string; color: string; values: number[] };
function niceMax(m: number) { if (m <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(m))); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

export function StackedBars({ buckets, series, bucketSeconds, height = 190, empty = 'No requests in this range' }: { buckets: string[]; series: Series[]; bucketSeconds: number; height?: number; empty?: string }) {
  const { t } = useTheme();
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] || 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const L = 34, B = 22, T = 8, plotW = Math.max(0, w - L), plotH = height - B - T;
  const slot = plotW / n, bw = Math.max(2, Math.min(28, slot * 0.68));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const none = totals.every((x) => x === 0);
  const ticks = [0, max / 2, max];
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1];
  return (
    <View onLayout={onLayout} style={{ height, position: 'relative' }}>
      {w > 0 && (
        <Svg width={w} height={height}>
          {ticks.map((tk) => {
            const yy = T + plotH - (tk / max) * plotH;
            return (<G key={tk}><Line x1={L} x2={w} y1={yy} y2={yy} stroke={t.border} strokeWidth={1} strokeDasharray={tk === 0 ? undefined : '2 4'} />
              <SvgText x={L - 8} y={yy + 4} fontSize={10.5} fill={t.muted} textAnchor="end" fontFamily={font(500)}>{int(Math.round(tk))}</SvgText></G>);
          })}
          {hover !== null && <Rect x={L + hover * slot} y={T} width={slot} height={plotH} fill={t.accentSoft} rx={6} />}
          {buckets.map((b, i) => {
            let y0 = T + plotH; const cx = L + i * slot + (slot - bw) / 2;
            const stack = series.filter((s) => s.values[i] > 0);
            return (
              <G key={b}>
                {stack.map((s, k) => {
                  const h = (s.values[i] / max) * plotH; y0 -= h;
                  const top = k === stack.length - 1;
                  return <Rect key={s.key} x={cx} y={y0} width={bw} height={Math.max(h, 1)} fill={s.color} stroke={t.surface} strokeWidth={h > 4 ? 1 : 0} rx={top ? Math.min(4, bw / 2) : 0} />;
                })}
              </G>
            );
          })}
          {labelIdx.filter((v, i, a) => a.indexOf(v) === i).map((i, k, arr) => (
            <SvgText key={i} x={L + i * slot + slot / 2} y={height - 5} fontSize={10.5} fill={t.muted} fontFamily={font(500)}
              textAnchor={k === 0 ? 'start' : k === arr.length - 1 && arr.length > 1 ? 'end' : 'middle'}>{bucketLabel(buckets[i], bucketSeconds)}</SvgText>
          ))}
        </Svg>
      )}
      {w > 0 && none && (
        <View pointerEvents="none" style={{ position: 'absolute', left: L, right: 0, top: T, height: plotH, alignItems: 'center', justifyContent: 'center' }}><Txt v="small" color="muted">{empty}</Txt></View>
      )}
      {w > 0 && !none && (
        <View style={{ position: 'absolute', left: L, top: T, width: plotW, height: plotH, flexDirection: 'row' }}>
          {buckets.map((b, i) => (
            <Pressable key={b} accessibilityLabel={`${bucketLabel(b, bucketSeconds)}: ${totals[i]} requests`} style={{ flex: 1 }}
              {...({ onHoverIn: () => setHover(i), onHoverOut: () => setHover((h) => (h === i ? null : h)) } as any)} onPress={() => setHover(i)} />
          ))}
        </View>
      )}
      {hover !== null && totals[hover] > 0 && w > 0 && (() => {
        const cx = L + hover * slot + slot / 2, tw = 190, left = Math.min(Math.max(cx - tw / 2, L), w - tw);
        return (
          <View pointerEvents="none" style={[{ position: 'absolute', left, top: 0, width: tw, backgroundColor: t.raised, borderRadius: 10, borderWidth: 1, borderColor: t.borderStrong, padding: 10, gap: 4 }, { boxShadow: t.shadow } as any]}>
            <Txt v="small" color="muted">{bucketLabel(buckets[hover], bucketSeconds)}</Txt>
            {series.filter((s) => s.values[hover] > 0).map((s) => (
              <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
                <Txt v="small" color="text2" style={{ flex: 1 }} numberOfLines={1}>{s.label}</Txt>
                <Txt v="small" style={{ fontFamily: font(600) }}>{int(s.values[hover])}</Txt>
              </View>
            ))}
            {series.filter((s) => s.values[hover] > 0).length > 1 && <Txt v="small" style={{ fontFamily: font(600), borderTopWidth: 1, borderTopColor: t.border, paddingTop: 4 }}>Total {int(totals[hover])}</Txt>}
          </View>
        );
      })()}
    </View>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, rowGap: 6 }}>
      {items.map((i) => (
        <View key={i.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: i.color }} />
          <Txt v="small" color="text2">{i.label}</Txt>
          {i.value ? <Txt v="small" style={{ fontFamily: font(600) }}>{i.value}</Txt> : null}
        </View>
      ))}
    </View>
  );
}

// ---------- segmented single bar (outcomes) ----------
export function ShareBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const { t } = useTheme();
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: t.track, gap: 2 }}>
        {parts.filter((p) => p.value > 0).map((p) => <View key={p.label} style={{ flex: p.value / Math.max(total, 1), backgroundColor: p.color }} />)}
      </View>
      <Legend items={parts.map((p) => ({ label: p.label, color: p.color, value: int(p.value) }))} />
    </View>
  );
}

// ---------- horizontal ranked bars ----------
export function HBars({ rows }: { rows: { label: string; value: number; color: string; right?: string }[] }) {
  const { t } = useTheme();
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={{ gap: 12 }}>
      {rows.map((r) => (
        <View key={r.label} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Txt v="small" color="text2" numberOfLines={1} style={{ flex: 1 }}>{r.label}</Txt>
            <Txt v="small" style={{ fontFamily: font(600) }}>{r.right ?? int(r.value)}</Txt>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.track, overflow: 'hidden' }}>
            <View style={{ width: `${(r.value / max) * 100}%`, height: '100%', backgroundColor: r.color, borderRadius: 4 }} />
          </View>
        </View>
      ))}
    </View>
  );
}
