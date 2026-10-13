import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { readStore, writeStore } from './store';

// Tokens come from the validated dataviz palette (categorical + status), stepped per mode.
const common = { good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b' };
const dark = {
  ...common, mode: 'dark' as const,
  bg: '#0d0e11', surface: '#15171c', surface2: '#1c1f26', raised: '#232730', border: '#272b34', borderStrong: '#363b47',
  text: '#f0efec', text2: '#c3c2b7', muted: '#868b98', accent: '#3987e5', accentSoft: 'rgba(57,135,229,0.16)',
  onAccent: '#ffffff', track: '#262a33', overlay: 'rgba(5,6,8,0.62)', shadow: '0 18px 50px rgba(0,0,0,0.45)',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const light = {
  ...common, mode: 'light' as const,
  bg: '#f4f4f1', surface: '#ffffff', surface2: '#f7f7f4', raised: '#ffffff', border: '#e6e5e0', borderStrong: '#d3d2cb',
  text: '#0b0b0b', text2: '#52514e', muted: '#8a8986', accent: '#2a78d6', accentSoft: 'rgba(42,120,214,0.10)',
  onAccent: '#ffffff', track: '#e9e8e3', overlay: 'rgba(20,20,18,0.35)', shadow: '0 18px 50px rgba(20,20,18,0.16)',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
};
export type Theme = Omit<typeof dark, 'mode'> & { mode: 'dark' | 'light' };

const Ctx = createContext<{ t: Theme; toggle: () => void }>({ t: dark, toggle: () => {} });
export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [override, setOverride] = useState<'dark' | 'light' | null>(() => readStore('theme') as any);
  const mode = override ?? (system === 'light' ? 'light' : 'dark');
  const value = useMemo(() => ({
    t: mode === 'dark' ? dark : light,
    toggle: () => { const next = mode === 'dark' ? 'light' : 'dark'; setOverride(next); writeStore('theme', next); },
  }), [mode]);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.background = value.t.bg;
      document.documentElement.style.colorScheme = mode;
    }
  }, [value, mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const font = (w: 400 | 500 | 600 | 700 = 400) =>
  ({ 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold' }[w]);
export const num = { fontVariant: ['tabular-nums'] } as any;
export const pointer = { cursor: 'pointer' } as any;

// Models keep one colour for life (colour follows the entity, never its rank).
const FIXED: Record<string, number> = { 'claude-opus-5-5': 0, 'claude-opus-4-8': 0, 'claude-sonnet-5-5': 1, 'claude-sonnet-4-6': 1, 'claude-haiku-4-5': 2, 'claude-haiku-5-5': 3 };
export function modelColor(t: Theme, model: string) {
  const key = Object.keys(FIXED).find((k) => model.startsWith(k));
  if (key !== undefined) return t.series[FIXED[key]];
  if (model === '(none)') return t.muted;
  let h = 0; for (const c of model) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return t.series[4 + (h % 4)];
}
export function userColor(t: Theme, index: number) { return t.series[index % t.series.length]; }

// Budget state: always paired with a text label so colour is never the only signal.
export type BudgetState = { key: 'nocap' | 'ok' | 'watch' | 'near' | 'over' | 'unlimited'; label: string; color: string; pct: number };
export function budgetState(t: Theme, spendCents: number, capCents: number | null, unlimited = false): BudgetState {
  if (unlimited) return { key: 'unlimited', label: 'Unlimited', color: t.accent, pct: 0 };
  if (capCents === null) return { key: 'nocap', label: 'No cap', color: t.muted, pct: 0 };
  if (capCents === 0) return { key: 'over', label: 'Blocked', color: t.crit, pct: 1 };
  const pct = spendCents / capCents;
  if (pct >= 1) return { key: 'over', label: 'At limit', color: t.crit, pct };
  if (pct >= 0.85) return { key: 'near', label: 'Near limit', color: t.serious, pct };
  if (pct >= 0.6) return { key: 'watch', label: 'Watch', color: t.warn, pct };
  return { key: 'ok', label: 'On track', color: t.good, pct };
}
