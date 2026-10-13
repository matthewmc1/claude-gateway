import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { DataSel, Period, Range, getMe, hasToken, health, setUnauthorizedHandler, signOut } from './src/api';
import { font, pointer, ThemeProvider, useTheme } from './src/theme';
import { Segmented, ToastProvider, Txt } from './src/ui';
import { Icon, IconName } from './src/icons';
import { readStore, writeStore } from './src/store';
import { Login } from './src/screens/Login';
import { People } from './src/screens/People';
import { Company } from './src/screens/Company';
import { Activity } from './src/screens/Activity';
import { UserDrawer } from './src/screens/UserDrawer';

type Tab = 'people' | 'company' | 'activity';
const TABS: { key: Tab; label: string; icon: IconName; title: string; sub: string }[] = [
  { key: 'people', label: 'People', icon: 'users', title: 'People', sub: 'Usage and budget for each person using Claude through the gateway.' },
  { key: 'company', label: 'Company', icon: 'building', title: 'Company', sub: 'Default budgets, exposure and usage across the whole team.' },
  { key: 'activity', label: 'Activity', icon: 'activity', title: 'Budget activity', sub: 'An audit trail of every budget change.' },
];
const parseHash = (): { tab: Tab; sub: string | null } => {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '').split('/') : [];
  const tab = (['people', 'company', 'activity'] as const).find((x) => x === h[0]) ?? 'people';
  return { tab, sub: tab === 'people' && h[1] ? decodeURIComponent(h[1]) : null };
};
const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => { const v = readStore(k) as T; return ok.includes(v) ? v : d; };

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { t, toggle } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 980;
  const [{ tab, sub }, setNav] = useState(parseHash);
  const [range, setRange] = useState<Range>(() => pick('range', ['24h', '7d', '30d'] as const, '7d'));
  const [data, setData] = useState<DataSel>(() => pick('data', ['all', 'real', 'loadtest'] as const, 'all'));
  const [period, setPeriod] = useState<Period>(() => pick('period', ['weekly', 'monthly'] as const, 'monthly'));
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState<{ gateway: boolean; usage: boolean | null; demo: boolean } | null>(null);

  useEffect(() => { const f = () => setNav(parseHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { let on = true; const f = () => health().then((s) => on && setStatus(s)).catch(() => on && setStatus({ gateway: false, usage: false, demo: false })); f(); const id = setInterval(f, 20000); return () => { on = false; clearInterval(id); }; }, []);
  const go = useCallback((tab: Tab, sub?: string | null) => { location.hash = `/${tab}${sub ? '/' + encodeURIComponent(sub) : ''}`; }, []);
  const set = <T extends string>(k: string, fn: (v: T) => void) => (v: T) => { fn(v); writeStore(k, v); };
  const setPer = set<Period>('period', setPeriod), setRng = set<Range>('range', setRange), setDat = set<DataSel>('data', setData);
  const meta = TABS.find((x) => x.key === tab)!;

  const controls = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', maxWidth: '100%', flexShrink: 1 }}>
      {tab === 'people' && <Segmented small value={period} onChange={setPer} options={[{ value: 'weekly', label: 'Week' }, { value: 'monthly', label: 'Month' }]} />}
      {tab !== 'activity' && <Segmented small value={range} onChange={setRng} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }]} />}
      {tab !== 'activity' && <Segmented small value={data} onChange={setDat} options={[{ value: 'all', label: 'All traffic' }, { value: 'real', label: 'Real' }, { value: 'loadtest', label: 'Load test' }]} />}
    </View>
  );

  const nav = TABS.map((x) => {
    const on = x.key === tab;
    return (
      <Pressable key={x.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => go(x.key)}
        style={(s: any) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: wide || width >= 560 ? 14 : 12, height: 42, borderRadius: 11, backgroundColor: on ? t.accentSoft : s.hovered ? t.surface2 : 'transparent' }, pointer]}>
        <Icon name={x.icon} size={18} color={on ? t.accent : t.text2} />
        {width >= 560 || on ? <Txt v="body" color={on ? t.text : t.text2} style={{ fontFamily: font(on ? 600 : 500) }}>{x.label}</Txt> : null}
      </Pressable>
    );
  });
  const dot = (ok: boolean | null | undefined, label: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok === undefined || ok === null ? t.muted : ok ? t.good : t.crit }} />
      <Txt v="small" color="muted">{label}{ok === false ? ' unreachable' : ok === null ? ' not connected' : ''}</Txt>
    </View>
  );
  const me = getMe();
  const footer = (
    <View style={{ gap: 12 }}>
      {me && me.email !== 'local-admin' ? <View style={{ gap: 2 }}><Txt v="small" style={{ fontFamily: font(600) }} numberOfLines={1}>{me.name}</Txt><Txt v="small" color="muted" numberOfLines={1}>{me.email}</Txt></View> : null}
      {dot(status?.gateway, 'Gateway')}{dot(status?.usage, 'Usage analytics')}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable accessibilityLabel="Toggle theme" onPress={toggle} style={(s: any) => [btn(t, s.hovered), pointer]}><Icon name={t.mode === 'dark' ? 'sun' : 'moon'} size={16} color={t.text2} /></Pressable>
        <Pressable accessibilityLabel="Sign out" onPress={onSignOut} style={(s: any) => [btn(t, s.hovered), pointer, { flex: 1, flexDirection: 'row', gap: 8, width: undefined, paddingHorizontal: 12 }]}><Icon name="logout" size={16} color={t.text2} /><Txt v="small" color="text2">Sign out</Txt></Pressable>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column', backgroundColor: t.bg }}>
      {wide ? (
        <View style={{ width: 244, padding: 18, justifyContent: 'space-between', borderRightWidth: 1, borderRightColor: t.border, backgroundColor: t.surface }}>
          <View style={{ gap: 28 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6, paddingTop: 6 }}>
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.accent + '66' }}><Icon name="activity" size={18} color={t.accent} /></View>
              <Txt v="h3">Gateway budgets</Txt>
            </View>
            <View style={{ gap: 4 }}>{nav}</View>
          </View>
          {footer}
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 2, flex: 1 }}>{nav.map((n) => n)}</View>
          <Pressable accessibilityLabel="Toggle theme" onPress={toggle} style={(s: any) => [btn(t, s.hovered), pointer]}><Icon name={t.mode === 'dark' ? 'sun' : 'moon'} size={16} color={t.text2} /></Pressable>
          <Pressable accessibilityLabel="Sign out" onPress={onSignOut} style={(s: any) => [btn(t, s.hovered), pointer]}><Icon name="logout" size={16} color={t.text2} /></Pressable>
        </View>
      )}

      <View style={{ flex: 1 }}>
        {status?.demo ? (
          <View style={{ backgroundColor: t.warn, paddingVertical: 7, paddingHorizontal: 16, alignItems: 'center' }}>
            <Txt v="small" color="#1a1300" style={{ fontFamily: font(700) }}>DEMO SPEND: the dollar amounts are fabricated for design review. Do not use for decisions.</Txt>
          </View>
        ) : null}
        <ScrollView contentContainerStyle={{ padding: wide ? 32 : 16, gap: 24, paddingBottom: 80, maxWidth: 1280, width: '100%', alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
            <View style={{ gap: 4, flexShrink: 1 }}>
              <Txt v="h1">{meta.title}</Txt>
              <Txt v="body" color="muted">{meta.sub}</Txt>
            </View>
            {controls}
          </View>
          {tab === 'people' && <People key={rev} range={range} data={data} period={period} onOpen={(s) => go('people', s)} />}
          {tab === 'company' && <Company key={rev} range={range} data={data} />}
          {tab === 'activity' && <Activity key={rev} />}
        </ScrollView>
      </View>
      {sub ? <UserDrawer sub={sub} range={range} data={data} onClose={() => go('people')} onChanged={() => setRev((r) => r + 1)} /> : null}
    </View>
  );
}
const btn = (t: any, hovered: boolean) => ({ width: 38, height: 38, borderRadius: 10, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: t.border });

function Root() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const [authed, setAuthed] = useState(hasToken());
  const { t } = useTheme();
  useEffect(() => { setUnauthorizedHandler(() => setAuthed(false)); }, []);
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  return (
    <ToastProvider>
      <StatusBar style={t.mode === 'dark' ? 'light' : 'dark'} />
      {authed ? <Shell onSignOut={() => { signOut(); setAuthed(false); }} /> : <Login onDone={() => setAuthed(true)} />}
    </ToastProvider>
  );
}
export default function App() { return <ThemeProvider><Root /></ThemeProvider>; }
