import { createSupabaseServerClient, MODEL_VERSION } from "@/lib/supabase";

// Details for the players on the Compare page over a chosen horizon (1, 3, 5 or 8 GWs). Everything is read
// from what the model stored on each projection (columns + components JSON); nothing is re-modelled here.
//
// Points range: each GW's range is the 10th–90th percentile of 2,000 simulated games (worker outcomes.py).
// Over several GWs the weeks are combined as independent: mean = sum of xPts, spread = √(sum of each week's
// variance), where a week's standard deviation ≈ (p90 − p10) ÷ 2.56; the range is mean ± 1.28 × spread
// (the 10th–90th percentile of a normal curve), floored at 0. P(1+ haul) = 1 − Π(1 − weekly haul chance).

export const HORIZONS = [1, 3, 5, 8] as const;
export type Horizon = (typeof HORIZONS)[number];

export type DetailGw = { gw: number; xp: number; p10: number; p50: number; p90: number; pHaul: number; pBlank: number; opp: string; fdr: number | null };
export type CompareDetail = {
  id: number;
  h: number;
  gws: DetailGw[];
  xp: number;
  lo: number;
  hi: number;
  median1: number | null; // next GW's simulated median (single-GW view only)
  pHaulAny: number; // chance of at least one 10+ pt week
  hauls: number; // expected number of 10+ pt weeks
  blanks: number; // expected number of 2-pt-or-fewer weeks
  comps: { appearance: number; goals: number; assists: number; cs: number; bonus: number; defcon: number; saves: number; deductions: number };
  pDc: number; // chance per game of reaching the DefCon threshold (2 pts)
  dc90: number; // his defensive contributions per 90
  pCs: number; // average clean-sheet chance per game
  pStart: number;
  p60: number;
  minsPerGame: number;
  xgShare: number; // his share of his team's xG
  xaShare: number;
  bonus90: number;
  setpieces: string[];
  teamXgFor: number; // his team's average expected goals per game
  teamXgAgainst: number;
  fdr: number | null;
};

type DetailRow = {
  player_id: number;
  gw: number;
  x_pts: number | null;
  x_appearance_pts: number | null;
  x_goals_pts: number | null;
  x_assist_pts: number | null;
  x_cs_pts: number | null;
  x_bonus_pts: number | null;
  x_defcon_pts: number | null;
  x_saves_pts: number | null;
  x_deductions_pts: number | null;
  range: { p10: number; p50: number; p90: number; p_haul: number; p_blank: number } | null;
  p_dc: number | null;
  p_cs: number[] | number | null;
  p_60: number | null;
  p_start: number | null;
  exp_minutes: number | null;
  n_fixtures: number | null;
  dc90: number | null;
  bonus90: number | null;
  xg_share: number | null;
  xa_share: number | null;
  setpieces: { pen?: boolean; corner?: boolean; fk?: boolean } | null;
  team_xg_for: number[] | null;
  team_xg_against: number[] | null;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const num = (v: unknown) => (v == null ? 0 : Number(v));

const SELECT =
  "player_id, gw, x_pts, x_appearance_pts, x_goals_pts, x_assist_pts, x_cs_pts, x_bonus_pts, x_defcon_pts, x_saves_pts, x_deductions_pts, " +
  "range:components->range, p_dc:components->p_dc, p_cs:components->p_cs, p_60:components->p_60, p_start:components->p_start, " +
  "exp_minutes:components->exp_minutes, n_fixtures:components->n_fixtures, dc90:components->why->dc90, bonus90:components->why->bonus90, " +
  "xg_share:components->why->xg_share, xa_share:components->why->xa_share, setpieces:components->why->setpieces, " +
  "team_xg_for:components->team_xg_for, team_xg_against:components->team_xg_against";

export async function loadCompareDetails(ids: number[], h: Horizon): Promise<CompareDetail[]> {
  if (!ids.length) return [];
  const sb = createSupabaseServerClient();
  const { data: first } = await sb.from("projections").select("gw").eq("model_version", MODEL_VERSION).order("gw").limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;
  if (nextGw == null) return [];
  const gws = Array.from({ length: h }, (_, i) => nextGw + i);

  const [projRes, playersRes, teamsRes, fxRes] = await Promise.all([
    sb.from("projections").select(SELECT).eq("model_version", MODEL_VERSION).in("player_id", ids).gte("gw", nextGw).lt("gw", nextGw + h).order("gw"),
    sb.from("players").select("fpl_id, team_id").in("fpl_id", ids),
    sb.from("teams").select("fpl_id, short_name"),
    sb.from("fixtures").select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, kickoff_time").in("gw", gws).order("kickoff_time"),
  ]);

  const short = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id as number, t.short_name as string]));
  const teamOf = new Map((playersRes.data ?? []).map((p) => [p.fpl_id as number, p.team_id as number]));
  const rows = (projRes.data ?? []) as unknown as DetailRow[];

  return ids.map((id) => {
    const mine = rows.filter((r) => r.player_id === id);
    const team = teamOf.get(id);
    const fx = (fxRes.data ?? []).flatMap((f) =>
      f.team_h === team
        ? [{ gw: f.gw as number, opp: `${short.get(f.team_a as number) ?? "?"} (H)`, fdr: f.custom_fdr_h as number | null }]
        : f.team_a === team
          ? [{ gw: f.gw as number, opp: `${short.get(f.team_h as number) ?? "?"} (A)`, fdr: f.custom_fdr_a as number | null }]
          : [],
    );

    const perGw: DetailGw[] = gws.map((gw) => {
      const r = mine.find((x) => x.gw === gw);
      const games = fx.filter((f) => f.gw === gw);
      const fdrs = games.map((g) => g.fdr).filter((x): x is number => x != null);
      return {
        gw,
        xp: r1(num(r?.x_pts)),
        p10: num(r?.range?.p10),
        p50: num(r?.range?.p50),
        p90: num(r?.range?.p90),
        pHaul: num(r?.range?.p_haul),
        pBlank: r?.range ? num(r.range.p_blank) : 1,
        opp: games.length ? games.map((g) => g.opp).join(", ") : "No game",
        fdr: fdrs.length ? r2(mean(fdrs)) : null,
      };
    });

    const xp = perGw.reduce((s, g) => s + g.xp, 0);
    const spread = Math.sqrt(perGw.reduce((s, g) => s + ((g.p90 - g.p10) / 2.5631) ** 2, 0));
    const single = h === 1 ? perGw[0] : null;
    const lo = single ? single.p10 : Math.max(0, xp - 1.2816 * spread);
    const hi = single ? single.p90 : xp + 1.2816 * spread;

    const sum = (f: (r: DetailRow) => number | null) => mine.reduce((s, r) => s + num(f(r)), 0);
    const games = mine.filter((r) => num(r.n_fixtures ?? 1) > 0);
    const csList = games.flatMap((r) => (Array.isArray(r.p_cs) ? r.p_cs : r.p_cs != null ? [r.p_cs] : []).map(Number));
    const latest = mine[0];
    const sp = latest?.setpieces ?? {};
    const fdrs = perGw.map((g) => g.fdr).filter((x): x is number => x != null);

    return {
      id,
      h,
      gws: perGw,
      xp: r1(xp),
      lo: r1(lo),
      hi: r1(hi),
      median1: single ? single.p50 : null,
      pHaulAny: r2(1 - perGw.reduce((p, g) => p * (1 - g.pHaul), 1)),
      hauls: r2(perGw.reduce((s, g) => s + g.pHaul, 0)),
      blanks: r1(perGw.reduce((s, g) => s + g.pBlank, 0)),
      comps: {
        appearance: r1(sum((r) => r.x_appearance_pts)),
        goals: r1(sum((r) => r.x_goals_pts)),
        assists: r1(sum((r) => r.x_assist_pts)),
        cs: r1(sum((r) => r.x_cs_pts)),
        bonus: r1(sum((r) => r.x_bonus_pts)),
        defcon: r1(sum((r) => r.x_defcon_pts)),
        saves: r1(sum((r) => r.x_saves_pts)),
        deductions: r1(sum((r) => r.x_deductions_pts)),
      },
      pDc: r2(mean(games.map((r) => num(r.p_dc)))),
      dc90: r1(num(latest?.dc90)),
      pCs: r2(mean(csList)),
      pStart: r2(mean(games.map((r) => num(r.p_start)))),
      p60: r2(mean(games.map((r) => num(r.p_60)))),
      minsPerGame: Math.round(mean(games.map((r) => num(r.exp_minutes) / Math.max(1, num(r.n_fixtures ?? 1))))),
      xgShare: r2(num(latest?.xg_share)),
      xaShare: r2(num(latest?.xa_share)),
      bonus90: r2(num(latest?.bonus90)),
      setpieces: [sp.pen && "Penalties", sp.corner && "Corners", sp.fk && "Free kicks"].filter(Boolean) as string[],
      teamXgFor: r2(mean(games.flatMap((r) => (r.team_xg_for ?? []).map(Number)))),
      teamXgAgainst: r2(mean(games.flatMap((r) => (r.team_xg_against ?? []).map(Number)))),
      fdr: fdrs.length ? r2(mean(fdrs)) : null,
    };
  });
}
