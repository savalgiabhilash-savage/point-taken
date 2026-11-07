import { createServerSupabase } from "@/lib/supabase/server";
import { liveGameweek } from "@/lib/live";

export const runtime = "nodejs";
export const maxDuration = 30;

// Live GW for the logged-in user: points so far, projected final, projected league ranks.
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: "Not signed in." }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("fpl_entry_id").eq("id", auth.user.id).maybeSingle();
  if (!profile?.fpl_entry_id) return Response.json({ error: "Set your FPL entry ID in Settings." }, { status: 400 });
  try {
    const data = await liveGameweek(supabase, profile.fpl_entry_id);
    return Response.json(data ?? { error: "No gameweek has started yet." }, { status: data ? 200 : 404 });
  } catch (err) {
    return Response.json({ error: `Live data failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
