import { createBrowserClient } from "@supabase/ssr";

// Strip any UTF-8 BOM the env value may carry (Windows pipe artifact) so it's a valid header byte.
const clean = (v: string | undefined) =>
  [...(v ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();

/** Browser-side Supabase client with the user's auth session (cookie-backed). */
export function createBrowserSupabase() {
  return createBrowserClient(
    clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}
