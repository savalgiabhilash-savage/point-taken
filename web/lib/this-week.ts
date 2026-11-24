import { chipStatus } from "@/lib/chips";
import type { SupabaseClient } from "@supabase/supabase-js";

// The "This week" card on My Team: everything to set before the next deadline, from the user's latest
// optimizer plan (optimizer_runs): this GW's transfers (path[0]), captain / vice / bench order from the
// planned squad, and a chip only when the chip plan plays it this GW.

type Move = { fpl_id: number; web_name: string; position: string; team_short: string };
type SquadP = Move & { is_start: boolean; is_captain: boolean; is_vice?: boolean; bench_order?: number };
type Step = { gw: number; in: Move[]; out: Move[]; num: number; hits: number; free: number; net?: number };
type Chip = { chip: string; gw: number; gain: number; available: boolean; plan_gw?: number | null; play_now?: boolean };

export type ThisWeek = {
  gw: number;
  deadline: string | null;
  swaps: { out: string; in: string | null }[];
  hits: number;
  freeAfter: number | null; // free transfers banked for next GW when rolling
  net: number | null;
  captain: string | null;
  vice: string | null;
  bench: string[];
  chip: { name: string; gain: number } | null;
  chipNext: { name: string; gw: number } | null; // the next planned chip when none is played this GW
  stale: boolean; // the squad changed since this plan was made
  planTime: string | null;
};

const label = (m: Move) => `${m.web_name} (${m.team_short})`;

/** Pair each player out with a player in of the same position (FPL swaps like for like). */
function pairUp(out: Move[], inn: Move[]) {
  const left = [...inn];
  return out.map((o) => {
    const i = left.findIndex((x) => x.position === o.position);
    const match = i >= 0 ? left.splice(i, 1)[0] : left.shift() ?? null;
    return { out: label(o), in: match ? label(match) : null };
  });
}

export async function loadThisWeek(sb: SupabaseClient, userId: string, currentIds: number[]): Promise<ThisWeek | null> {
  const { data: runs } = await sb
    .from("optimizer_runs")
    .select("gw, suggested_squad, transfers, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  const run = runs?.[0];
  if (!run) return null;
  const t = (run.transfers ?? {}) as { path?: Step[]; chips?: Chip[]; based_on?: number[] };
  const step = t.path?.[0] ?? null;
  const gw = step?.gw ?? (run.gw as number);
  const squad = (run.suggested_squad ?? []) as SquadP[];

  const { data: dl } = await sb.from("gw_deadlines").select("deadline").eq("gw", gw).maybeSingle();

  // The chip plan's verdict (lib/chips.ts), the same on every screen: play it only when its week is this GW.
  const play = (t.chips ?? []).find((c) => chipStatus(c) === "now" && c.gw === gw);
  const next = (t.chips ?? [])
    .filter((c) => chipStatus(c) === "planned" && c.plan_gw)
    .sort((a, b) => a.plan_gw! - b.plan_gw!)[0];

  const basedOn = [...(t.based_on ?? [])].sort((a, b) => a - b);
  const cur = [...currentIds].sort((a, b) => a - b);
  const stale = basedOn.length > 0 && cur.length > 0 && (basedOn.length !== cur.length || basedOn.some((id, i) => id !== cur[i]));

  const captain = squad.find((p) => p.is_captain);
  const vice = squad.find((p) => p.is_vice);
  const bench = squad
    .filter((p) => !p.is_start)
    .sort((a, b) => (a.bench_order ?? 9) - (b.bench_order ?? 9))
    .map((p) => p.web_name);

  return {
    gw,
    deadline: (dl?.deadline as string | undefined) ?? null,
    swaps: step && step.num > 0 ? pairUp(step.out, step.in) : [],
    hits: step?.hits ?? 0,
    freeAfter: step && step.num === 0 ? Math.min(5, (step.free ?? 0) + 1) : null,
    net: step?.net ?? null,
    captain: captain ? captain.web_name : null,
    vice: vice ? vice.web_name : null,
    bench,
    chip: play ? { name: play.chip, gain: play.gain } : null,
    chipNext: next ? { name: next.chip, gw: next.plan_gw! } : null,
    stale,
    planTime: (run.created_at as string | null) ?? null,
  };
}
