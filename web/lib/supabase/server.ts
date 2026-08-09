import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const clean = (v: string | undefined) =>
  [...(v ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();

/** Server-side Supabase client bound to the request cookies (so it reads the user's session). */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component (cookies are read-only there); the middleware refreshes the session.
          }
        },
      },
    },
  );
}
