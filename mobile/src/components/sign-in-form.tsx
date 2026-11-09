import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, useColorScheme, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const ACCENT = '#10b981';

// Email + password sign-in against the same Supabase accounts as the web app. Accounts are created on
// the website (point-taken-fpl.vercel.app/login), where you also link your FPL entry in Settings.
export function SignInForm() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !email || !password) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    // On success the session listener (useSession) swaps this form for the team.
    if (error) setErr(error.message);
    setBusy(false);
  };

  const input = [styles.input, { backgroundColor: c.backgroundElement, color: c.text }];

  return (
    <View style={styles.wrap}>
      <ThemedText type="small" style={{ color: c.textSecondary }}>
        Sign in with your FPL Selector account to see your squad. New here? Create an account at
        point-taken-fpl.vercel.app and add your FPL entry ID in Settings.
      </ThemedText>
      <TextInput
        placeholder="Email"
        placeholderTextColor={c.textSecondary}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        style={input}
      />
      <TextInput
        placeholder="Password"
        placeholderTextColor={c.textSecondary}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        textContentType="password"
        onSubmitEditing={submit}
        returnKeyType="go"
        style={input}
      />
      {err ? <ThemedText type="small" style={styles.err}>{err}</ThemedText> : null}
      <Pressable
        onPress={submit}
        disabled={busy || !email || !password}
        style={({ pressed }) => [styles.button, (pressed || busy || !email || !password) && styles.dim]}>
        {busy ? <ActivityIndicator color="#fff" /> : <ThemedText type="smallBold" style={styles.buttonText}>Sign in</ThemedText>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two, marginTop: Spacing.two },
  input: { height: 44, borderRadius: 10, paddingHorizontal: Spacing.three },
  err: { color: '#f43f5e' },
  button: { height: 44, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff' },
  dim: { opacity: 0.6 },
});
