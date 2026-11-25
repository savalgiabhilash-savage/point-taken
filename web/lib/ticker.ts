import type { SupabaseClient } from "@supabase/supabase-js";
import { MODEL_VERSION } from "@/lib/supabase";
import { getForm, FORM_GAMES } from "@/lib/form";

// Fixture ticker: how easy each upcoming fixture is, from the opponent's CURRENT form blended with the model.
//
// For team T against opponent O (per fixture):
//   form goals for     = O's goals conceded a game over its last 6 x (1.1 at home, 0.9 away)
//   form goals against = O's goals scored a game over its last 6   x (0.9 at home, 1.1 away)
//   model goals for / against = the model's expected goals for T in that fixture (team_model, home advantage
//                               and both sides' strength; read from a T player's projection components)
//   goals for / against = FORM_W x form + (1 - FORM_W) x model
// Views: Attack = goals for (good for T's attackers); Defence = - goals against (clean-sheet chances);
// Overall = goals for - goals against. Colours are relative: the page ranks every fixture in view and splits
// them into five equal bands, so green always means "among the easiest on show".

export const FORM_W = 0.6;
export const TICKER_GWS = 8;
const HOME = 1.1;
const AWAY = 0.9;

export type TickerFixture = {
  gw: number;
  opp: string;
  oppName: string;
  home: boolean;
  gf: number; // blended expected goals for
  ga: number; // blended expected goals against
  formGf: number;
  formGa: number;
  modelGf: number | null;
  modelGa: number | null;
  oppForm: { gf: number; ga: number; pts: number; games: number; res: string };
};
export type TickerTeam = { id: number; short: string; name: string; crest: string; byGw: Record<number, TickerFixture[]> };

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function loadTicker(sb: SupabaseClient): Promise<{ teams: TickerTeam[]; gws: number[] }> {
  const [{ teams: form }, fxRes, plRes] = await Promise.all([
    getForm(sb),
    sb.from("fixtures").select("gw, team_h, team_a, kickoff_time").eq("finished", false).not("gw", "is", null).order("kickoff_time"),
    sb.from("players").select("fpl_id, team_id, minutes").order("minutes", { ascending: false }),
  ]);
  const fixtures = fxRes.data ?? [];
  const gws = [...new Set(fixtures.map((f) => f.gw as number))].sort((a, b) => a - b).slice(0, TICKER_GWS);
  const byId = new Map(form.map((t) => [t.id, t]));

  // The model's expected goals per team-fixture: one regular per club (most minutes) carries his club's
  // team_xg_for / team_xg_against for each fixture of each GW, in the same order as `opponents`.
  const rep = new Map<number, number>();
  for (const p of plRes.data ?? []) if (!rep.has(p.team_id as number)) rep.set(p.team_id as number, p.fpl_id as number);
  const model = new Map<string, { gf: number; ga: number }[]>(); // key `${team}:${gw}:${opp}`
  if (gws.length) {
    const { data: proj } = await sb
      .from("projections")
      .select("player_id, gw, opponents:components->opponents, xf:components->team_xg_for, xa:components->team_xg_against")
      .eq("model_version", MODEL_VERSION)
      .in("player_id", [...rep.values()])
      .in("gw", gws);
    const teamOf = new Map([...rep.entries()].map(([t, p]) => [p, t]));
    for (const r of proj ?? []) {
      const opps = (r.opponents ?? []) as string[];
      opps.forEach((o, i) => {
        const key = `${teamOf.get(r.player_id as number)}:${r.gw}:${o}`;
        const xf = (r.xf as number[] | null)?.[i];
        const xa = (r.xa as number[] | null)?.[i];
        if (xf != null && xa != null) model.set(key, [...(model.get(key) ?? []), { gf: xf, ga: xa }]);
      });
    }
  }

  const teams: TickerTeam[] = form
    .map((t) => ({ id: t.id, short: t.short, name: t.name, crest: t.crest, byGw: {} as Record<number, TickerFixture[]> }))
    .sort((a, b) => a.short.localeCompare(b.short));
  const tById = new Map(teams.map((t) => [t.id, t]));
  const used = new Map<string, number>(); // DGW vs the same opponent twice: take the model rows in order

  for (const f of fixtures) {
    if (!gws.includes(f.gw as number)) continue;
    for (const [me, opp, home] of [[f.team_h, f.team_a, true], [f.team_a, f.team_h, false]] as [number, number, boolean][]) {
      const O = byId.get(opp);
      const T = tById.get(me);
      if (!O || !T) continue;
      const formGf = O.ga * (home ? HOME : AWAY);
      const formGa = O.gf * (home ? AWAY : HOME);
      const key = `${me}:${f.gw}:${O.short}`;
      const k = used.get(key) ?? 0;
      used.set(key, k + 1);
      const m = model.get(key)?.[k] ?? null;
      const gf = m ? FORM_W * formGf + (1 - FORM_W) * m.gf : formGf;
      const ga = m ? FORM_W * formGa + (1 - FORM_W) * m.ga : formGa;
      (T.byGw[f.gw as number] ??= []).push({
        gw: f.gw as number, opp: O.short, oppName: O.name, home,
        gf: r2(gf), ga: r2(ga), formGf: r2(formGf), formGa: r2(formGa),
        modelGf: m ? r2(m.gf) : null, modelGa: m ? r2(m.ga) : null,
        oppForm: { gf: r2(O.gf), ga: r2(O.ga), pts: O.pts, games: O.recent.length, res: O.recent.map((x) => x.res).join("") },
      });
    }
  }
  return { teams, gws };
}

export { FORM_GAMES };
