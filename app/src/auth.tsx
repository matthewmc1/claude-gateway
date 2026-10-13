import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Cancelled, ApiError, Health, Me, getMe, hasToken, health as fetchHealth, login, setUnauthorizedHandler, signOut as dropToken, logout as revokeSession } from './api';
import { needsGate } from './logic/nav';
import { font, useTheme } from './theme';
import { Button, Card, Dialog, TextField, Txt, useToast } from './ui';
import { Logo } from './Logo';
import { Icon } from './icons';

type Auth = {
  health: Health | null; unreachable: boolean; admin: Me | null; gate: boolean;
  /** Run an admin-only action. Opens the sign-in dialog first if needed, and again if the session turns out to be expired (401). */
  runAdmin: <T,>(why: string, fn: () => Promise<T>) => Promise<T>;
  openSignIn: (why?: string) => Promise<boolean>;
  signOut: () => void; refresh: () => void; onSignedIn: (m: Me) => void;
};
const Ctx = createContext<Auth>({ health: null, unreachable: false, admin: null, gate: false, runAdmin: (_w, f) => f(), openSignIn: async () => false, signOut() {}, refresh() {}, onSignedIn() {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [me, setMe] = useState<Me | null>(() => (hasToken() ? getMe() : null));
  const [dialog, setDialog] = useState<{ why: string } | null>(null);
  const waiter = useRef<((ok: boolean) => void) | null>(null);
  const changedAt = useRef(0);                         // health replies that started before the last sign-in/out are stale

  const refresh = useCallback(() => {
    const started = Date.now();
    fetchHealth().then((h) => {
      setUnreachable(false); setHealth(h);
      if (started < changedAt.current) return;
      if (h.admin) setMe(h.admin);
      else if (hasToken()) { dropToken(); setMe(null); }       // the server no longer recognises our session
      else setMe(null);
    }).catch(() => setUnreachable(true));
  }, []);
  useEffect(() => { refresh(); const id = setInterval(refresh, 20000); return () => clearInterval(id); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(() => { changedAt.current = Date.now(); setMe(null); refresh(); }); }, [refresh]);

  const openSignIn = useCallback((why = 'Sign in as an admin to make changes.') => new Promise<boolean>((resolve) => { waiter.current?.(false); waiter.current = resolve; setDialog({ why }); }), []);
  const finish = (ok: boolean) => { setDialog(null); const w = waiter.current; waiter.current = null; w?.(ok); };
  const runAdmin = useCallback(async <T,>(why: string, fn: () => Promise<T>): Promise<T> => {
    if (!hasToken() && !(await openSignIn(why))) throw new Cancelled();
    try { return await fn(); } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null); changedAt.current = Date.now();
        if (!(await openSignIn('Your session expired. Sign in again and your change will go through.'))) throw new Cancelled();
        return await fn();
      }
      throw e;
    }
  }, [openSignIn]);
  const signOut = useCallback(() => { void revokeSession(); changedAt.current = Date.now(); setMe(null); toast('Signed out'); refresh(); }, [toast, refresh]);

  const onSignedIn = useCallback((m: Me) => { changedAt.current = Date.now(); setMe(m); toast(`Signed in as ${m.name}`); refresh(); }, [toast, refresh]);
  const admin = me ?? null;
  const value = useMemo<Auth>(() => ({ health, unreachable, admin, gate: needsGate(health?.viewAccess, admin), runAdmin, openSignIn, signOut, refresh, onSignedIn }), [health, unreachable, admin, runAdmin, openSignIn, signOut, refresh, onSignedIn]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog ? <Dialog label="Admin sign in" onClose={() => finish(false)}><LoginForm why={dialog.why} accounts={!!health?.accounts} onCancel={() => finish(false)} onDone={(m) => { onSignedIn(m); finish(true); }} /></Dialog> : null}
    </Ctx.Provider>
  );
}

function LoginForm({ why, accounts, onDone, onCancel }: { why: string; accounts: boolean; onDone: (m: Me) => void; onCancel?: () => void }) {
  const { t } = useTheme();
  const [pw, setPw] = useState(''); const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const ready = !!pw && (!accounts || !!email);
  const go = async () => {
    if (!ready || busy) return; setBusy(true); setErr(null);
    try { onDone(await login(pw, email)); } catch (e: any) { setErr(e.message || 'Could not sign in'); setBusy(false); }
  };
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="lock" size={17} color={t.accent} /></View>
          <Txt v="h2">Admin sign in</Txt>
        </View>
        <Txt v="small" color="muted">{why}</Txt>
      </View>
      {accounts ? <TextField value={email} onChangeText={setEmail} autoFocus label="Work email" placeholder="Work email" inputMode="email" invalid={!!err} onSubmit={go} /> : null}
      <TextField value={pw} onChangeText={setPw} autoFocus={!accounts} label="Admin password" placeholder={accounts ? 'Password' : 'Admin password'} secure invalid={!!err} onSubmit={go} />
      {err ? <Text accessibilityRole="alert" style={{ fontFamily: font(500), fontSize: 13, color: t.crit }}>{err}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {onCancel ? <Button label="Cancel" onPress={onCancel} style={{ flex: 1 }} /> : null}
        <Button kind="primary" label="Sign in" busy={busy} disabled={!ready} onPress={go} style={{ flex: 2 }} />
      </View>
    </View>
  );
}

/** Shown instead of the app only when the backend runs with APP_VIEW_ACCESS=admin and nobody is signed in. */
export function SignInGate() {
  const { t } = useTheme(); const { health, unreachable, onSignedIn } = useAuth();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.bg }}>
      <View style={{ width: '100%', maxWidth: 400, gap: 24 }}>
        <View style={{ gap: 14, alignItems: 'flex-start' }}>
          <Logo size={48} />
          <Txt v="display">Gateway Budgets</Txt>
          <Txt v="body" color="muted">This deployment keeps usage private. Sign in as an admin to see budgets and usage.</Txt>
        </View>
        <Card>
          <LoginForm why="Use your admin account to continue." accounts={!!health?.accounts} onDone={onSignedIn} />
        </Card>
        {unreachable ? <Txt v="small" color={t.crit}>Cannot reach the budget service right now.</Txt> : null}
      </View>
    </View>
  );
}
