import { createServerSupabase } from "@/lib/supabase/server";
import { triggerReoptimize } from "@/lib/reoptimize";

export const runtime = "nodejs";
export const maxDuration = 30;

const FPL = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 fpl-selector (personal FPL tool)";
const ALL_CHIPS = ["wildcard", "freehit", "bboost", "3xc"];
const FT_CAP = 5;
// Since 2025/26 each chip comes twice: one set for GW1-19 (lost if unused), a fresh set for GW20-38.
const CHIP_HALF_END = 19;

// Chips still playable in the half-season containing `gw` (mirrors worker sync_team.py).
function chipsAvailableFor(history: { chips?: { event: number; name: string }[] }, gw: number): string[] {
  const [lo, hi] = gw <= CHIP_HALF_END ? [1, CHIP_HALF_END] : [CHIP_HALF_END + 1, 38];
  const played = new Set((history.chips ?? []).filter((c) => c.event >= lo && c.event <= hi).map((c) => c.name));
  return ALL_CHIPS.filter((c) => !played.has(c));
}

type HistoryEvent = { event: number; event_transfers?: number; event_transfers_cost?: number };

// Free transfers for the next deadline, rebuilt from the entry history (mirrors worker sync_team.py).
// entry_history.event_transfers is transfers MADE, not available. First GW played is unlimited; +1 per GW
// after, capped at 5; hits (cost/4) don't use free ones; Wildcard / Free Hit keep your banked transfers.
function freeTransfersNext(history: { current?: HistoryEvent[]; chips?: { event: number; name: string }[] }): number {
  const chipGws = new Set((history.chips ?? []).filter((c) => c.name === "wildcard" || c.name === "freehit").map((c) => c.event));
  const events = [...(history.current ?? [])].sort((a, b) => a.event - b.event);
  if (!events.length) return 1;
  let ft = 1;
  for (const e of events.slice(1)) {
    if (!chipGws.has(e.event)) {
      const usedFree = (e.event_transfers ?? 0) - Math.floor((e.event_transfers_cost ?? 0) / 4);
      ft = Math.max(0, ft - usedFree);
    }
    ft = Math.min(FT_CAP, ft + 1);
  }
  return ft;
}

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
      // Preseason: FPL keeps the squad private on the public API until GW1's deadline. Recover the
      // most recent known snapshot for this entry (an earlier import / previous sync) into this account.
      const { data: snap } = await supabase
        .from("user_team_state")
        .select("*")
        .eq("fpl_entry_id", entryId)
        .order("gw", { ascending: false })
        .limit(1);
      const s = snap?.[0] as { gw: number; bank: number | null; team_value: number | null; free_transfers: number | null; chips_available: string[] | null; picks: unknown[] | null; rank: number | null } | undefined;
      if (s?.picks?.length) {
        const { error } = await supabase.from("user_team_state").upsert(
          {
            user_id: user.id,
            fpl_entry_id: entryId,
            gw: s.gw,
            bank: s.bank,
            team_value: s.team_value,
            free_transfers: s.free_transfers,
            chips_available: s.chips_available,
            picks: s.picks,
            rank: s.rank,
          },
          { onConflict: "user_id,gw" },
        );
        if (error) throw new Error(error.message);
        await triggerReoptimize({ userId: user.id });
        return Response.json({
          synced: true,
          message: `"${entry.name ?? entryId}" is private on FPL until GW1's deadline, so I loaded your latest saved squad — ${s.picks.length} players. It'll refresh from live data automatically once the season starts.`,
        });
      }
      return Response.json({
        synced: false,
        message: `Found your team "${entry.name ?? entryId}", but no squad is available yet — FPL keeps preseason teams private until the GW1 deadline. It'll sync automatically then.`,
      });
    }

    const chipsAvailable = chipsAvailableFor(history, (currentEvent ?? 0) + 1); // half of the next deadline
    const eh = (history.current ?? []).at(-1) ?? {};

    const { error } = await supabase.from("user_team_state").upsert(
      {
        user_id: user.id,
        fpl_entry_id: entryId,
        gw: currentEvent,
        bank: eh.bank ?? null,
        team_value: eh.value ?? null,
        free_transfers: freeTransfersNext(history),
        chips_available: chipsAvailable,
        picks: picksData.picks,
        rank: eh.overall_rank ?? null,
      },
      { onConflict: "user_id,gw" },
    );
    if (error) throw new Error(error.message);
    await triggerReoptimize({ userId: user.id });

    return Response.json({
      synced: true,
      message: `Synced "${entry.name ?? entryId}" — ${picksData.picks.length} players, GW${currentEvent}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Sync failed: ${msg}` }, { status: 502 });
  }
}
