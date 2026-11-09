import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, useColorScheme, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const ACCENT = '#10b981';

// Closes the sign-in browser window if the app was reopened from it (needed on web; harmless elsewhere).
WebBrowser.maybeCompleteAuthSession();

// Google sign-in: Supabase gives us Google's sign-in URL, we open it in a secure in-app browser, and Google
// (via Supabase) sends the browser back to pointtaken://auth/callback?code=…, which ends the browser session.
// We swap that one-time code for a session; the session listener then shows the team.
async function signInWithGoogle(): Promise<string | null> {
  const redirectTo = Linking.createURL('auth/callback');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data?.url) return error?.message ?? 'Could not start Google sign-in.';
  const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (res.type !== 'success') return null; // closed or cancelled: no message
  const code = new URL(res.url).searchParams.get('code');
  if (!code) return "Google sign-in didn't finish. Please try again.";
  const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
  return exErr ? exErr.message : null;
}

// Sign-in against the same Supabase accounts as the web app: Google, or email + password. Accounts are
// created on the website (point-taken-fpl.vercel.app/login) or by Google sign-in; the FPL entry is linked in
// the website's Settings.
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

  const google = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setErr(await signInWithGoogle());
    setBusy(false);
  };

  const input = [styles.input, { backgroundColor: c.backgroundElement, color: c.text }];

  return (
    <View style={styles.wrap}>
      <ThemedText type="small" style={{ color: c.textSecondary }}>
        Sign in with your Point Taken account to see your squad. New here? Sign in with Google, or create an
        account at point-taken-fpl.vercel.app, then add your FPL entry ID in Settings there.
      </ThemedText>
      <Pressable
        onPress={google}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => [styles.google, (pressed || busy) && styles.dim]}>
        <ThemedText type="smallBold" style={styles.googleText}>Continue with Google</ThemedText>
      </Pressable>
      <ThemedText type="small" style={[styles.or, { color: c.textSecondary }]}>or with email</ThemedText>
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
  google: { height: 44, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#dadce0', alignItems: 'center', justifyContent: 'center' },
  googleText: { color: '#1f1f1f' },
  or: { textAlign: 'center' },
  dim: { opacity: 0.6 },
});
