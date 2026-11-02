import type { SupabaseClient } from "@supabase/supabase-js";

// Opponent labels for pitch cards: { gw: { teamShort: "v BOU (H)" | "v AVL (A)" | "v BOU (H), v AVL (A)" } }.
// Every game reads "v OPP" with (H) home or (A) away; a double gameweek lists both. Clubs with no fixture that
// GW are absent (cards show "no game"). Built from the fixtures table, so it's cheap for any GW.
export async function opponentLabels(sb: SupabaseClient, gws: number[]): Promise<Record<number, Record<string, string>>> {
  const want = [...new Set(gws.filter((g) => g != null))];
  if (!want.length) return {};
  const [teamsRes, fxRes] = await Promise.all([
    sb.from("teams").select("fpl_id, short_name"),
    sb.from("fixtures").select("gw, team_h, team_a, kickoff_time").in("gw", want).order("kickoff_time"),
  ]);
  const short = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id as number, t.short_name as string]));
  const out: Record<number, Record<string, string[]>> = {};
  for (const f of fxRes.data ?? []) {
    const h = short.get(f.team_h as number);
    const a = short.get(f.team_a as number);
    if (!h || !a) continue;
    const g = (out[f.gw as number] ??= {});
    (g[h] ??= []).push(`v ${a} (H)`);
    (g[a] ??= []).push(`v ${h} (A)`);
  }
  return Object.fromEntries(
    Object.entries(out).map(([gw, m]) => [Number(gw), Object.fromEntries(Object.entries(m).map(([t, v]) => [t, v.join(", ")]))]),
  );
}
