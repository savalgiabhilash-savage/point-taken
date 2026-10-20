import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

// Same Supabase project and accounts as the web app. Shared data (players, projections) is public;
// your own team needs sign-in (email + password), and RLS returns only your rows. The session is kept
// in AsyncStorage, so you stay signed in between launches.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(url, anon, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh the session token only while the app is in the foreground (Supabase's React Native
// guidance): a backgrounded app can't run timers reliably, so restart the refresh when it comes back.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

export const MODEL_VERSION = 'rules-v8'; // must match worker/fpl_worker/model.py
