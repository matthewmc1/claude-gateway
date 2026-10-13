import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { health, login } from '../api';
import { font, useTheme } from '../theme';
import { Button, Card, Txt } from '../ui';
import { Icon } from '../icons';

export function Login({ onDone }: { onDone: () => void }) {
  const { t } = useTheme();
  const [pw, setPw] = useState(''); const [email, setEmail] = useState(''); const [accounts, setAccounts] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { health().then((h) => setAccounts(!!h.accounts)).catch(() => {}); }, []);
  const go = async () => {
    if (!pw || (accounts && !email) || busy) return; setBusy(true); setErr(null);
    try { await login(pw, email); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.bg }}>
      <View style={{ width: '100%', maxWidth: 400, gap: 24 }}>
        <View style={{ gap: 14, alignItems: 'flex-start' }}>
          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.accent + '66' }}><Icon name="activity" size={24} color={t.accent} /></View>
          <Txt v="display">Gateway budgets</Txt>
          <Txt v="body" color="muted">Track Claude usage per person and set weekly and monthly budgets.</Txt>
        </View>
        <Card style={{ gap: 14 }}>
          <Txt v="label">{accounts ? 'Admin sign-in' : 'Admin password'}</Txt>
          {accounts ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface2, borderWidth: 1, borderColor: err ? t.crit : t.borderStrong, borderRadius: 12, paddingHorizontal: 14, height: 48 }}>
              <TextInput value={email} onChangeText={setEmail} autoFocus autoCapitalize="none" inputMode="email" placeholder="Work email" placeholderTextColor={t.muted} accessibilityLabel="Work email"
                style={[{ flex: 1, fontFamily: font(500), fontSize: 15, color: t.text, padding: 0 }, { outlineStyle: 'none' } as any]} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface2, borderWidth: 1, borderColor: err ? t.crit : t.borderStrong, borderRadius: 12, paddingHorizontal: 14, height: 48 }}>
            <Icon name="lock" size={16} color={t.muted} />
            <TextInput value={pw} onChangeText={setPw} secureTextEntry autoFocus={!accounts} onSubmitEditing={go} placeholder={accounts ? 'Password' : 'From APP_ADMIN_PASSWORD in .env'} placeholderTextColor={t.muted} accessibilityLabel="Admin password"
              style={[{ flex: 1, fontFamily: font(500), fontSize: 15, color: t.text, padding: 0 }, { outlineStyle: 'none' } as any]} />
          </View>
          {err ? <Text style={{ fontFamily: font(500), fontSize: 13, color: t.crit }}>{err}</Text> : null}
          <Button kind="primary" label="Sign in" busy={busy} disabled={!pw || (accounts && !email)} onPress={go} />
        </Card>
      </View>
    </View>
  );
}
