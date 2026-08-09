import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const clean = (v: string | undefined) =>
  [...(v ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();

/** Refresh the Supabase auth session on each request so server components see a valid user. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Touch the user to trigger a token refresh + cookie write when needed.
  await supabase.auth.getUser();
  return response;
}
