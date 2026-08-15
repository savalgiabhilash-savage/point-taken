import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Same Supabase project as the web app — the mobile app reads the shared public data (players,
// projections, the "me" demo) with the anon key, subject to the same RLS. Auth (sign-in) lands in a
// later increment; the AsyncStorage session config is wired now so it persists once we add it.
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

export const MODEL_VERSION = 'rules-v1';
