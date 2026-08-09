import { createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const FPL = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 fpl-selector (personal FPL tool)";
const ALL_CHIPS = ["wildcard", "freehit", "bboost", "3xc"];

async function fpl(path: string) {
  const res = await fetch(`${FPL}/${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`FPL ${path} → ${res.status}`);
  return res.json();
}

// Sync the logged-in user's FPL team from the public /entry/ endpoints into user_team_state.
export async function POST() {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("fpl_entry_id").eq("id", user.id).maybeSingle();
  const entryId = profile?.fpl_entry_id;
  if (!entryId) return Response.json({ error: "Set your FPL entry ID first." }, { status: 400 });

  try {
    const entry = await fpl(`entry/${entryId}/`);
    const history = await fpl(`entry/${entryId}/history/`);
    const currentEvent: number | null = entry.current_event ?? null;
    const picksData = currentEvent ? await fpl(`entry/${entryId}/event/${currentEvent}/picks/`).catch(() => null) : null;

    if (!picksData?.picks?.length) {
      return Response.json({
        synced: false,
        message: `Found your team "${entry.name ?? entryId}", but its squad isn't public yet (no gameweek has started). It'll sync automatically once GW1's deadline passes.`,
      });
    }

    const played = new Set((history.chips ?? []).map((c: { name: string }) => c.name));
    const chipsAvailable = ALL_CHIPS.filter((c) => !played.has(c));
    const eh = (history.current ?? []).at(-1) ?? {};

    const { error } = await supabase.from("user_team_state").upsert(
      {
        user_id: user.id,
        fpl_entry_id: entryId,
        gw: currentEvent,
        bank: eh.bank ?? null,
        team_value: eh.value ?? null,
        free_transfers: eh.event_transfers ?? null,
        chips_available: chipsAvailable,
        picks: picksData.picks,
        rank: eh.overall_rank ?? null,
      },
      { onConflict: "user_id,gw" },
    );
    if (error) throw new Error(error.message);

    return Response.json({
      synced: true,
      message: `Synced "${entry.name ?? entryId}" — ${picksData.picks.length} players, GW${currentEvent}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Sync failed: ${msg}` }, { status: 502 });
  }
}
