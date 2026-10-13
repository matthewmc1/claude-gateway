import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';
import { font, num, pointer, useTheme } from './theme';
import { Icon, IconName } from './icons';
import { initials } from './format';

export function useTween(target: number, ms = 650): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current, t0 = Date.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      from.current = start + (target - start) * e; setV(from.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

type Variant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'label' | 'metric';
const V: Record<Variant, { size: number; w: 400 | 500 | 600 | 700; lh: number; ls?: number }> = {
  display: { size: 34, w: 700, lh: 40, ls: -0.8 }, h1: { size: 26, w: 700, lh: 32, ls: -0.5 }, h2: { size: 18, w: 600, lh: 24, ls: -0.2 },
  h3: { size: 15, w: 600, lh: 20 }, body: { size: 14, w: 400, lh: 20 }, small: { size: 12.5, w: 400, lh: 17 },
  label: { size: 11, w: 600, lh: 14, ls: 0.7 }, metric: { size: 28, w: 700, lh: 32, ls: -0.6 },
};
export function Txt({ v = 'body', color, style, children, numberOfLines, ...rest }: {
  v?: Variant; color?: 'text' | 'text2' | 'muted' | string; style?: StyleProp<TextStyle>; children: React.ReactNode; numberOfLines?: number; selectable?: boolean }) {
  const { t } = useTheme(); const s = V[v];
  const c = color === undefined ? (v === 'label' ? t.muted : t.text) : (color === 'text' || color === 'text2' || color === 'muted') ? t[color] : color;
  return <Text numberOfLines={numberOfLines} {...rest} style={[{ fontFamily: font(s.w), fontSize: s.size, lineHeight: s.lh, letterSpacing: s.ls, color: c, textTransform: v === 'label' ? 'uppercase' : undefined }, num, style]}>{children}</Text>;
}

export function Card({ children, style, pad = 20 }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number }) {
  const { t } = useTheme();
  return <View style={[{ backgroundColor: t.surface, borderRadius: 16, borderWidth: 1, borderColor: t.border, padding: pad }, style]}>{children}</View>;
}

export function Button({ label, onPress, icon, kind = 'secondary', busy, disabled, small, style }: {
  label?: string; onPress?: () => void; icon?: IconName; kind?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean; disabled?: boolean; small?: boolean; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.crit : kind === 'secondary' ? t.surface2 : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? t.onAccent : t.text;
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={off} onPress={onPress}
      style={(s: any) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: small ? 32 : 40, paddingHorizontal: small ? 12 : 16, borderRadius: 10,
        backgroundColor: bg, borderWidth: kind === 'secondary' || kind === 'ghost' ? 1 : 0, borderColor: kind === 'ghost' ? 'transparent' : t.border,
        opacity: off ? 0.5 : s.pressed ? 0.8 : 1, transform: [{ scale: s.pressed ? 0.98 : 1 }] }, s.hovered && !off && kind !== 'primary' && kind !== 'danger' ? { backgroundColor: t.raised, borderColor: t.borderStrong } : null, s.hovered && !off && (kind === 'primary' || kind === 'danger') ? { opacity: 0.9 } : null, pointer, style]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={16} color={fg} /> : null}
      {label ? <Text style={{ fontFamily: font(600), fontSize: small ? 12.5 : 14, color: fg }}>{label}</Text> : null}
    </Pressable>
  );
}

export function IconButton({ icon, onPress, label, size = 36 }: { icon: IconName; onPress: () => void; label: string; size?: number }) {
  const { t } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={(s: any) => [{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: s.hovered ? t.surface2 : 'transparent' }, pointer]}>
      <Icon name={icon} size={18} color={t.text2} />
    </Pressable>
  );
}

export function Chip({ label, color, icon, solid }: { label: string; color: string; icon?: IconName; solid?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, height: 22, borderRadius: 11, backgroundColor: solid ? color : color + '24', alignSelf: 'flex-start' }}>
      {icon ? <Icon name={icon} size={12} color={solid ? '#fff' : color} stroke={2.4} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: solid ? '#fff' : color }} />}
      <Text style={{ fontFamily: font(600), fontSize: 11.5, color: solid ? '#fff' : color }}>{label}</Text>
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange, small }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; small?: boolean }) {
  const { t } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', backgroundColor: t.surface2, borderRadius: 11, padding: 3, borderWidth: 1, borderColor: t.border }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)}
            style={(s: any) => [{ paddingHorizontal: small ? 10 : 14, height: small ? 26 : 30, borderRadius: 8, justifyContent: 'center', backgroundColor: on ? t.raised : 'transparent',
              borderWidth: 1, borderColor: on ? t.borderStrong : 'transparent' }, s.hovered && !on ? { backgroundColor: t.border } : null, pointer]}>
            <Text style={{ fontFamily: font(on ? 600 : 500), fontSize: small ? 12 : 13, color: on ? t.text : t.text2 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Avatar({ name, seed, size = 40 }: { name: string; seed: number; size?: number }) {
  const { t } = useTheme();
  const c = t.series[seed % t.series.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c + '30', borderWidth: 1.5, borderColor: c + '80', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: font(700), fontSize: size * 0.36, color: c }}>{initials(name)}</Text>
    </View>
  );
}

export function Skeleton({ h = 16, w = '100%', r = 8 }: { h?: number; w?: number | string; r?: number }) {
  const { t } = useTheme();
  const a = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(a, { toValue: 1, duration: 800, useNativeDriver: false }), Animated.timing(a, { toValue: 0.45, duration: 800, useNativeDriver: false })]));
    loop.start(); return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ height: h, width: w as any, borderRadius: r, backgroundColor: t.track, opacity: a }} />;
}

export function Empty({ title, hint, icon = 'users' }: { title: string; hint?: string; icon?: IconName }) {
  const { t } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, gap: 8 }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={22} color={t.muted} /></View>
      <Txt v="h3">{title}</Txt>
      {hint ? <Txt v="small" color="muted" style={{ textAlign: 'center', maxWidth: 360 }}>{hint}</Txt> : null}
    </View>
  );
}

// ---- toast ----
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error'; k: number } | null>(null);
  const show = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => setToast({ msg, kind, k: Date.now() }), []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3200); return () => clearTimeout(id); }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 28, left: 0, right: 0, alignItems: 'center', zIndex: 100 }}>
          <View accessibilityRole="alert" style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.raised, borderColor: t.borderStrong, borderWidth: 1, paddingHorizontal: 16, height: 44, borderRadius: 12, maxWidth: '92%' }, { boxShadow: t.shadow } as any]}>
            <Icon name={toast.kind === 'ok' ? 'check' : 'alert'} size={16} color={toast.kind === 'ok' ? t.good : t.crit} stroke={2.4} />
            <Text style={{ fontFamily: font(500), fontSize: 14, color: t.text }}>{toast.msg}</Text>
          </View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

export function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' }) {
  const { t } = useTheme(); const c = tone === 'warn' ? t.warn : t.accent;
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 14, borderRadius: 12, backgroundColor: c + '14', borderWidth: 1, borderColor: c + '44' }}>
      <Icon name="alert" size={16} color={c} />
      <Text style={{ flex: 1, fontFamily: font(500), fontSize: 13, lineHeight: 18, color: t.text2 }}>{text}</Text>
    </View>
  );
}
