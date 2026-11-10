import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { triggerReoptimize } from "@/lib/reoptimize";

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
  const { data } = await supabase.auth.getUser();
  if (data.user && !request.cookies.get(SEEN_COOKIE)) await markSeen(supabase, data.user.id, response);
  return response;
}

// "Last seen" for the scheduled jobs: they only sync and re-optimize users seen in the last 7 days
// (worker/fpl_worker/active_users.py). Written at most once per 6 hours per user (a short-lived cookie
// gates it), so it costs one small query per user per 6 hours, not one per request. A user coming back after
// more than 7 days gets an immediate re-optimize, since the schedule skipped them while they were away.
const SEEN_COOKIE = "pt_seen";
const SEEN_EVERY_S = 6 * 60 * 60;
const AWAY_MS = 7 * 24 * 60 * 60 * 1000;

async function markSeen(supabase: ReturnType<typeof createServerClient>, userId: string, response: NextResponse) {
  try {
    response.cookies.set(SEEN_COOKIE, "1", { maxAge: SEEN_EVERY_S, httpOnly: true, sameSite: "lax", path: "/" });
    const { data: prof, error } = await supabase.from("profiles").select("last_seen_at, fpl_entry_id").eq("id", userId).maybeSingle();
    if (error) return; // e.g. column missing before migration 0013; retried after the cookie expires
    if (!prof) return; // no profile yet (connects their FPL team in Settings first)
    await supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", userId);
    const last = prof.last_seen_at ? Date.parse(prof.last_seen_at as string) : null;
    if (prof.fpl_entry_id && last != null && Date.now() - last > AWAY_MS) {
      await triggerReoptimize({ userId }); // best-effort; never throws
    }
  } catch {
    // never let bookkeeping break a page load
  }
}
