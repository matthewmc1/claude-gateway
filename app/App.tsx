import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { DataSel, Period, Range } from './src/api';
import { AuthProvider, SignInGate, useAuth } from './src/auth';
import { font, pointer, ThemeProvider, useTheme } from './src/theme';
import { Banner, Button, Segmented, ToastProvider, Txt } from './src/ui';
import { Icon, IconName } from './src/icons';
import { Logo } from './src/Logo';
import { ErrorBoundary } from './src/ErrorBoundary';
import { readStore, writeStore } from './src/store';
import { Tab, TAB_META, hashFor, pageTitle, parseHash } from './src/logic/nav';
import { identityLine, roleLine } from './src/logic/iap';
import { People } from './src/screens/People';
import { MyUsage } from './src/screens/MyUsage';
import { Company } from './src/screens/Company';
import { Models } from './src/screens/Models';
import { Activity } from './src/screens/Activity';
import { UserDrawer } from './src/screens/UserDrawer';

const ICONS: Record<Tab, IconName> = { people: 'users', 'my-usage': 'clock', company: 'building', models: 'layers', activity: 'activity' };
const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => { const v = readStore(k) as T; return ok.includes(v) ? v : d; };
const btn = (t: any, hovered: boolean) => ({ width: 38, height: 38, borderRadius: 10, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: t.border });

/** 'Admin sign in' when signed out; the admin's name with a Sign out menu when signed in. */
function AdminButton() {
  const { t } = useTheme(); const { admin, openSignIn, signOut, iap, health } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, [open]);
  const who = iap ? health?.identity ?? null : null;                  // behind IAP the company sign-in is the only identity: no sign-in button, no sign-out
  if (iap && !who) return null;
  if (!iap && !admin) return <Button small icon="lock" label="Admin sign in" onPress={() => openSignIn()} />;
  const shown = who ? who.name : admin!.email === 'local-admin' ? 'Admin' : admin!.name;
  const email = who ? who.email : admin!.email;
  return (
    <View style={{ position: 'relative', zIndex: 30 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Signed in as ${shown}${who ? who.admin ? ', admin' : ', viewer' : ''}. Open menu`} accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}
        style={(s: any) => [{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 32, paddingHorizontal: 12, borderRadius: 10, backgroundColor: s.hovered ? t.raised : t.surface2, borderWidth: 1, borderColor: t.border }, pointer]}>
        <Icon name={who && !who.admin ? 'users' : 'shield'} size={15} color={who && !who.admin ? t.muted : t.good} />
        <Txt v="small" style={{ fontFamily: font(600), maxWidth: 160 }} numberOfLines={1}>{shown}</Txt>
        <Icon name="chevron" size={13} color={t.muted} />
      </Pressable>
      {open ? (
        <>
          <Pressable accessibilityLabel="Close menu" onPress={() => setOpen(false)} style={{ position: 'fixed' as any, top: 0, left: 0, right: 0, bottom: 0 }} />
          <View accessibilityRole="menu" style={[{ position: 'absolute', top: 38, right: 0, minWidth: 220, backgroundColor: t.raised, borderRadius: 12, borderWidth: 1, borderColor: t.borderStrong, padding: 6, gap: 2 }, { boxShadow: t.shadow } as any]}>
            <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 2 }}>
              <Txt v="small" style={{ fontFamily: font(600) }} numberOfLines={1}>{shown}</Txt>
              {who ? <Txt v="small" color="muted">{identityLine(who)}</Txt> : email !== 'local-admin' ? <Txt v="small" color="muted" numberOfLines={1}>{email}</Txt> : null}
              {who ? <Txt v="small" color={who.admin ? 'text2' : 'muted'} style={{ fontFamily: font(600) }}>{roleLine(who.admin)}</Txt> : null}
            </View>
            {who ? null : <Pressable accessibilityRole="menuitem" onPress={() => { setOpen(false); signOut(); }} style={(s: any) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, height: 36, borderRadius: 8, backgroundColor: s.hovered ? t.surface2 : 'transparent' }, pointer]}>
              <Icon name="logout" size={15} color={t.text2} /><Txt v="small" color="text2">Sign out</Txt>
            </Pressable>}
          </View>
        </>
      ) : null}
    </View>
  );
}

function Shell() {
  const { t, toggle } = useTheme();
  const { health, unreachable } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 980;
  const [{ tab, sub }, setNav] = useState(() => parseHash(typeof location !== 'undefined' ? location.hash : ''));
  const [range, setRange] = useState<Range>(() => pick('range', ['24h', '7d', '30d'] as const, '7d'));
  const [data, setData] = useState<DataSel>(() => pick('data', ['all', 'real', 'loadtest'] as const, 'all'));
  const [period, setPeriod] = useState<Period>(() => pick('period', ['weekly', 'monthly'] as const, 'monthly'));
  const [rev, setRev] = useState(0);

  useEffect(() => { const f = () => setNav(parseHash(location.hash)); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { document.title = pageTitle(tab); }, [tab]);
  const go = useCallback((tab: Tab, sub?: string | null) => { location.hash = hashFor(tab, sub); }, []);
  const set = <T extends string>(k: string, fn: (v: T) => void) => (v: T) => { fn(v); writeStore(k, v); };
  const setPer = set<Period>('period', setPeriod), setRng = set<Range>('range', setRange), setDat = set<DataSel>('data', setData);
  const meta = TAB_META.find((x) => x.key === tab)!;

  const controls = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', maxWidth: '100%', flexShrink: 1 }}>
      {tab === 'people' && <Segmented small value={period} onChange={setPer} options={[{ value: 'weekly', label: 'Week' }, { value: 'monthly', label: 'Month' }]} />}
      {tab !== 'activity' && <Segmented small value={range} onChange={setRng} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }]} />}
      {tab !== 'activity' && <Segmented small value={data} onChange={setDat} options={[{ value: 'all', label: 'All traffic' }, { value: 'real', label: 'Real' }, { value: 'loadtest', label: 'Load test' }]} />}
    </View>
  );

  const nav = TAB_META.map((x) => {
    const on = x.key === tab;
    const labelled = wide || width >= 720;
    return (
      <Pressable key={x.key} accessibilityRole="link" accessibilityLabel={x.label} accessibilityState={{ selected: on }} {...({ 'aria-current': on ? 'page' : undefined } as any)} onPress={() => go(x.key)}
        style={(s: any) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: wide ? 14 : labelled ? 12 : 11, height: 42, borderRadius: 11, backgroundColor: on ? t.accentSoft : s.hovered ? t.surface2 : 'transparent' }, pointer]}>
        <Icon name={ICONS[x.key]} size={18} color={on ? t.accent : t.text2} />
        {labelled ? <Txt v="body" color={on ? t.text : t.text2} style={{ fontFamily: font(on ? 600 : 500) }} numberOfLines={1}>{x.label}</Txt> : null}
      </Pressable>
    );
  });

  const usageSource = health?.usage.source;
  const usageState = unreachable || !health ? { c: t.muted, l: 'Usage analytics' } : usageSource === 'none' ? { c: t.muted, l: 'Usage analytics not connected' } : health.usage.ok === false ? { c: t.crit, l: 'Usage analytics unreachable' } : { c: t.good, l: 'Usage analytics & coach' };
  const gwState = unreachable ? { c: t.crit, l: 'Budget service unreachable' } : !health ? { c: t.muted, l: 'Gateway' } : health.gateway ? { c: t.good, l: 'Gateway connected' } : { c: t.crit, l: 'Gateway unreachable' };
  const dot = (c: string, l: string) => (
    <View key={l} accessibilityLabel={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
      <Txt v="small" color="muted">{l}</Txt>
    </View>
  );
  const themeBtn = <Pressable accessibilityRole="button" accessibilityLabel="Toggle theme" onPress={toggle} style={(s: any) => [btn(t, s.hovered), pointer]}><Icon name={t.mode === 'dark' ? 'sun' : 'moon'} size={16} color={t.text2} /></Pressable>;
  const footer = (
    <View style={{ gap: 12 }} accessibilityLabel="Connection status">
      {dot(gwState.c, gwState.l)}
      {dot(usageState.c, usageState.l)}
      {health?.demo ? dot(t.warn, 'Sample data') : null}
      <Txt v="small" color="muted" style={{ fontSize: 11, lineHeight: 15 }}>Independent open-source project. Not affiliated with Anthropic.</Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {themeBtn}
        <Button label="Refresh" icon="refresh" onPress={() => setRev((r) => r + 1)} style={{ flex: 1 }} />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column', backgroundColor: t.bg }}>
      {wide ? (
        <View style={{ width: 244, padding: 18, justifyContent: 'space-between', borderRightWidth: 1, borderRightColor: t.border, backgroundColor: t.surface }}>
          <View style={{ gap: 28 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6, paddingTop: 6 }}>
              <Logo />
              <View><Txt v="h3">Gateway Budgets</Txt><Txt v="small" color="muted" style={{ fontSize: 11 }}>Claude on Vertex AI</Txt></View>
            </View>
            <View {...({ role: "navigation" } as any)} style={{ gap: 4 }}>{nav}</View>
          </View>
          {footer}
        </View>
      ) : (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ paddingHorizontal: 4 }}><Logo size={30} /></View>
          <View {...({ role: "navigation" } as any)} style={{ flexDirection: 'row', gap: 2, flex: 1, flexWrap: 'wrap' }}>{nav}</View>
          <View accessibilityLabel={`${gwState.l}. ${usageState.l}`} style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: gwState.c }} /><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: usageState.c }} />
          </View>
          {themeBtn}
        </View>
      )}

      <View style={{ flex: 1 }}>
        {health?.demo ? <Banner tone="warn" title="Sample data" text="Usage and dollar amounts here are generated for demonstration. Do not use them for decisions." /> : null}
        <ScrollView contentContainerStyle={{ padding: wide ? 32 : 16, gap: 24, paddingBottom: 80, maxWidth: 1280, width: '100%', alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, zIndex: 20 }}>
            <View style={{ gap: 4, flexShrink: 1, flexBasis: 320, flexGrow: 1 }}>
              <Txt v="h1" {...({ accessibilityRole: 'header', 'aria-level': 1 } as any)}>{meta.title}</Txt>
              <Txt v="body" color="muted" style={{ maxWidth: 720 }}>{meta.sub}</Txt>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 1 }}>
              {controls}
              <AdminButton />
            </View>
          </View>
          <ErrorBoundary key={tab + ':' + rev} what="this page">
          {tab === 'people' && <People key={rev} range={range} data={data} period={period} onOpen={(s) => go('people', s)} />}
          {tab === 'my-usage' && <MyUsage key={rev} range={range} data={data} />}
          {tab === 'company' && <Company key={rev} range={range} data={data} onOpenActivity={() => go('activity')} />}
          {tab === 'models' && <Models key={rev} range={range} data={data} />}
          {tab === 'activity' && <Activity key={rev} />}
          </ErrorBoundary>
        </ScrollView>
      </View>
      {sub && tab === 'people' ? <ErrorBoundary what="this person" onDismiss={() => go('people')}><UserDrawer sub={sub} range={range} data={data} onClose={() => go('people')} onChanged={() => setRev((r) => r + 1)} /></ErrorBoundary> : null}
    </View>
  );
}

function Root() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const { t } = useTheme();
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  return (
    <ToastProvider>
      <StatusBar style={t.mode === 'dark' ? 'light' : 'dark'} />
      <AuthProvider><Gate /></AuthProvider>
    </ToastProvider>
  );
}
function Gate() {
  const { t } = useTheme(); const { gate, health, unreachable, denied } = useAuth();
  if (!health && !unreachable && !denied) return <View style={{ flex: 1, backgroundColor: t.bg }} />;   // first health reply decides between app and sign-in page
  return gate ? <SignInGate /> : <Shell />;
}
export default function App() { return <ThemeProvider><ErrorBoundary what="the app"><Root /></ErrorBoundary></ThemeProvider>; }
