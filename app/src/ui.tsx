import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, StyleProp, Text, TextInput, TextStyle, View, ViewStyle } from 'react-native';
import { font, num, pointer, useTheme } from './theme';
import { Icon, IconName } from './icons';
import { initials, plain } from './format';
import { copyText } from './clipboard';
import { useModalFocus } from './hooks';

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
  v?: Variant; color?: 'text' | 'text2' | 'muted' | string; style?: StyleProp<TextStyle>; children: React.ReactNode; numberOfLines?: number; selectable?: boolean; accessibilityRole?: 'alert' | 'header' | 'text' }) {
  const { t } = useTheme(); const s = V[v];
  const c = color === undefined ? (v === 'label' ? t.muted : t.text) : (color === 'text' || color === 'text2' || color === 'muted') ? t[color] : color;
  // People-supplied strings (names, reasons, notes) are drawn as plain text with bidi and control characters removed.
  const kids = typeof children === 'string' ? plain(children) : Array.isArray(children) ? React.Children.map(children, (x) => (typeof x === 'string' ? plain(x) : x)) : children;
  return <Text numberOfLines={numberOfLines} {...rest} style={[{ fontFamily: font(s.w), fontSize: s.size, lineHeight: s.lh, letterSpacing: s.ls, color: c, textTransform: v === 'label' ? 'uppercase' : undefined }, num, style]}>{kids}</Text>;
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
      <Text style={{ fontFamily: font(600), fontSize: 11.5, color: solid ? '#fff' : color }}>{plain(label)}</Text>
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
      {initials(name) ? <Text style={{ fontFamily: font(700), fontSize: size * 0.36, color: c }}>{initials(name)}</Text> : <Icon name="users" size={size * 0.44} color={c} />}
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
type ToastKind = 'ok' | 'warn' | 'error';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind; k: number } | null>(null);
  const show = useCallback((msg: string, kind: ToastKind = 'ok') => setToast({ msg, kind, k: Date.now() }), []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), toast.kind === 'ok' ? 3200 : toast.msg.length > 90 ? 11000 : 7000); return () => clearTimeout(id); }, [toast]);
  const color = toast ? (toast.kind === 'ok' ? t.good : toast.kind === 'warn' ? t.warn : t.crit) : t.good;
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 28, left: 0, right: 0, alignItems: 'center', zIndex: 300, paddingHorizontal: 12 }}>
          <View accessibilityRole="alert" style={[{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: t.raised, borderColor: toast.kind === 'ok' ? t.borderStrong : color, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, minHeight: 44, borderRadius: 12, maxWidth: 560 }, { boxShadow: t.shadow } as any]}>
            <View style={{ marginTop: 2 }}><Icon name={toast.kind === 'ok' ? 'check' : 'alert'} size={16} color={color} stroke={2.4} /></View>
            <Text style={{ flexShrink: 1, fontFamily: font(500), fontSize: 14, lineHeight: 20, color: t.text }}>{plain(toast.msg)}</Text>
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

// ---------- inputs ----------
export function TextField({ value, onChangeText, placeholder, label, prefix, suffix, secure, autoFocus, onSubmit, multiline, invalid, maxLength, inputMode, style }: {
  value: string; onChangeText: (s: string) => void; placeholder?: string; label: string; prefix?: string; suffix?: string; secure?: boolean; autoFocus?: boolean; onSubmit?: () => void;
  multiline?: boolean; invalid?: boolean; maxLength?: number; inputMode?: 'text' | 'decimal' | 'numeric' | 'email'; style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <View style={[{ flexDirection: 'row', alignItems: multiline ? 'flex-start' : 'center', gap: 8, backgroundColor: t.surface2, borderWidth: 1, borderColor: invalid ? t.crit : focus ? t.accent : t.borderStrong, borderRadius: 12, paddingHorizontal: 14, minHeight: multiline ? 76 : 44, paddingVertical: multiline ? 10 : 0 }, style]}>
      {prefix ? <Text style={{ fontFamily: font(600), fontSize: 16, color: t.muted }}>{prefix}</Text> : null}
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={t.muted} accessibilityLabel={label} secureTextEntry={secure} autoFocus={autoFocus}
        onSubmitEditing={onSubmit} multiline={multiline} maxLength={maxLength} inputMode={inputMode} autoCapitalize="none" onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={[{ flex: 1, fontFamily: font(500), fontSize: 15, color: t.text, padding: 0, minWidth: 0 }, multiline ? { minHeight: 54, textAlignVertical: 'top' } : null, { outlineStyle: 'none' } as any]} />
      {suffix ? <Txt v="small" color="muted">{suffix}</Txt> : null}
    </View>
  );
}

/** Native <select> on web (free keyboard + screen-reader support); a simple cycling button elsewhere. */
export function Select<T extends string>({ value, options, onChange, label, minWidth = 0 }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; minWidth?: number }) {
  const { t } = useTheme();
  if (Platform.OS === 'web') {
    return React.createElement('select', {
      value, 'aria-label': label, onChange: (e: any) => onChange(e.target.value as T),
      style: { appearance: 'none', WebkitAppearance: 'none', width: '100%', minWidth, height: 44, borderRadius: 12, border: `1px solid ${t.borderStrong}`, background: t.surface2 + ' url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\' viewBox=\'0 0 12 8\'><path d=\'M1 1.5l5 5 5-5\' fill=\'none\' stroke=\'%23868b98\' stroke-width=\'1.8\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/></svg>") no-repeat right 14px center', color: t.text, fontFamily: font(500), fontSize: 14, padding: '0 38px 0 14px', cursor: 'pointer' },
    }, options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)));
  }
  const i = options.findIndex((o) => o.value === value);
  return <Button label={options[i]?.label ?? label} onPress={() => onChange(options[(i + 1) % options.length].value)} />;
}

/** A shell command with a Copy button. */
export function CommandBox({ cmd, hint }: { cmd: string; hint?: string }) {
  const { t } = useTheme(); const toast = useToast();
  const copy = async () => { const ok = await copyText(cmd); toast(ok ? `Copied: ${cmd}` : 'Could not copy. Select the command and copy it by hand.', ok ? 'ok' : 'error'); };
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingLeft: 12, paddingRight: 4, minHeight: 38 }}>
        <Text selectable numberOfLines={2} style={[{ flex: 1, fontFamily: MONO, fontSize: 12.5, lineHeight: 17, color: t.accent, paddingVertical: 8 }]}>{cmd}</Text>
        <Button small kind="ghost" label="Copy" icon="copy" onPress={copy} />
      </View>
      {hint ? <Txt v="small" color="muted">{hint}</Txt> : null}
    </View>
  );
}
export const MONO = Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', default: 'Courier' }) as string;

/** Small "Admin" tag with a lock while signed out: marks controls that need an admin session. */
export function AdminTag({ signedIn }: { signedIn: boolean }) {
  const { t } = useTheme();
  return (
    <View accessibilityLabel={signedIn ? 'Admin action' : 'Admin action, sign in required'} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 22, borderRadius: 11, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface2, alignSelf: 'flex-start' }}>
      <Icon name={signedIn ? 'shield' : 'lock'} size={11} color={t.text2} stroke={2.3} />
      <Text style={{ fontFamily: font(600), fontSize: 11, color: t.text2 }}>Admin</Text>
    </View>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <View>
      <Empty icon="alert" title={title} hint={message} />
      {onRetry ? <View style={{ alignItems: 'center', paddingBottom: 24 }}><Button label="Try again" icon="refresh" onPress={onRetry} /></View> : null}
    </View>
  );
}

/** Centered dialog over a dimmed backdrop. Escape and a backdrop press close it. */
export function Dialog({ children, onClose, label, width = 420 }: { children: React.ReactNode; onClose: () => void; label: string; width?: number }) {
  const { t } = useTheme();
  const ref = useRef<any>(null);
  useModalFocus(ref);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // Capture phase + stop: Escape closes only this dialog, not a drawer underneath it.
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', h, true); return () => document.removeEventListener('keydown', h, true);
  }, [onClose]);
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Pressable accessibilityLabel="Close dialog" onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.overlay }} />
      <View ref={ref} accessibilityViewIsModal accessibilityLabel={label} {...({ role: 'dialog', 'aria-modal': true, 'aria-label': label } as any)} style={[{ width: '100%', maxWidth: width, backgroundColor: t.surface, borderRadius: 18, borderWidth: 1, borderColor: t.border, padding: 22 }, { boxShadow: t.shadow } as any]}>{children}</View>
    </View>
  );
}

export function Banner({ tone, title, text }: { tone: 'warn' | 'info'; title: string; text: string }) {
  const { t } = useTheme();
  const bg = tone === 'warn' ? t.warn : t.accent;
  const fg = tone === 'warn' ? '#1a1300' : t.onAccent;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: bg, paddingVertical: 8, paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <Text style={{ fontFamily: font(700), fontSize: 12.5, letterSpacing: 0.6, textTransform: 'uppercase', color: fg }}>{title}</Text>
      <Text style={{ fontFamily: font(500), fontSize: 12.5, color: fg, textAlign: 'center', flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

/** A multi-line, selectable code sample. */
export function CodeBlock({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <View style={{ backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 }}>
      <Text selectable style={{ fontFamily: MONO, fontSize: 12, lineHeight: 18, color: t.text2 }}>{text}</Text>
    </View>
  );
}
