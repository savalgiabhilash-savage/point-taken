import { createSupabaseServerClient, MODEL_VERSION } from "@/lib/supabase";

// Data for the Compare page: every player with the numbers the comparison shows, plus FC-style ratings.
//
// Ratings (1–99) re-express a player's own numbers, they are not new predictions. Most are scaled against the
// best in the "pool" (players projected at least 1 pt over the next 5 GWs, so long-term absentees don't count):
// rating = 99 × √(value ÷ pool best). The best player gets 99; the square root spreads the top end like FC
// cards (a player with half the best value gets 70, a quarter gets 50). Plain percentiles squashed every
// premium player to 97–99, which is exactly where people compare.
//   OVR  projected points over the next 5 GWs            (floor 40)
//   FRM  FPL form (points per game, last 30 days)
//   ATT  season xG + xA per 90 (FPL's numbers; players with 270+ minutes set the best)
//   DEF  next-5 projected clean-sheet + DefCon points
//   VAL  next-5 projected points per £1m
//   MIN  expected minutes per game over the next 5 GWs   → minutes / 90 × 99 (absolute)
//   FIX  average fixture difficulty next 5 (lower=easier) → 30 + 69 × percentile of ease among the pool

export const HORIZON = 5;
const POOL_MIN_XP5 = 1;

export type Fixture = { gw: number; opp: string; fdr: number | null };
export type ComparePlayer = {
  id: number;
  name: string;
  fullName: string;
  team: string;
  pos: string;
  photo: string | null; // FPL's player photo (code-based); the card falls back to initials
  price: number; // £m
  own: number; // % selected
  status: string;
  chance: number | null; // FPL chance of playing next round, %
  form: number;
  totalPts: number;
  minutes: number;
  xg90: number;
  xa90: number;
  xp1: number; // next GW
  xp5: number; // next 5 GWs
  start: number; // chance to start next GW, 0–1
  mins: number; // expected minutes per game over the next 5
  csdef5: number; // next-5 clean-sheet + DefCon points
  fdr: number | null; // average custom fixture difficulty next 5
  fixtures: Fixture[];
  ovr: number;
  attrs: { FRM: number; ATT: number; DEF: number; MIN: number; FIX: number; VAL: number };
};

// p_start, exp_minutes and n_fixtures live in the projection's components JSON (the same-named columns are empty).
type ProjRow = { player_id: number; gw: number; x_pts: number | null; p_start: number | null; exp_minutes: number | null; n_fixtures: number | null; x_cs_pts: number | null; x_defcon_pts: number | null };

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Share of the pool strictly below v (0–1). `sorted` is ascending. */
function pct(v: number, sorted: number[]): number {
  if (!sorted.length) return 0;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo / Math.max(1, sorted.length - 1);
}
const scale = (p: number, base: number) => Math.max(1, Math.min(99, Math.round(base + (99 - base) * Math.min(1, p))));
/** 99 × √(v ÷ best), clamped to 1–99 (see the header comment). */
const vsBest = (v: number, best: number, floor = 1) =>
  best > 0 ? Math.max(floor, Math.min(99, Math.round(99 * Math.sqrt(Math.max(0, v) / best)))) : floor;

export async function loadCompare(): Promise<{ players: ComparePlayer[]; gws: number[] }> {
  const sb = createSupabaseServerClient();
  const { data: first } = await sb.from("projections").select("gw").eq("model_version", MODEL_VERSION).order("gw").limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;
  if (nextGw == null) return { players: [], gws: [] };
  const gws = Array.from({ length: HORIZON }, (_, i) => nextGw + i);

  // Projections are paged (PostgREST returns at most 1000 rows per request).
  const projPromise = (async () => {
    const all: ProjRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("projections")
        .select("player_id, gw, x_pts, x_cs_pts, x_defcon_pts, p_start:components->p_start, exp_minutes:components->exp_minutes, n_fixtures:components->n_fixtures")
        .eq("model_version", MODEL_VERSION)
        .gte("gw", nextGw)
        .lt("gw", nextGw + HORIZON)
        .order("player_id")
        .order("gw")
        .range(from, from + 999);
      const batch = (data ?? []) as ProjRow[];
      all.push(...batch);
      if (batch.length < 1000) break;
    }
    return all;
  })();

  const [playersRes, teamsRes, fxRes, proj] = await Promise.all([
    sb.from("players").select(
      "fpl_id, code, web_name, full_name, team_id, position, now_cost, selected_by_percent, status, chance_of_playing_next_round, form, total_points, minutes, expected_goals_per_90, expected_assists_per_90",
    ),
    sb.from("teams").select("fpl_id, short_name"),
    sb.from("fixtures").select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, kickoff_time").in("gw", gws).order("kickoff_time"),
    projPromise,
  ]);

  const short = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id as number, t.short_name as string]));
  const fixturesByTeam = new Map<number, Fixture[]>();
  for (const f of fxRes.data ?? []) {
    const add = (team: number, fx: Fixture) => (fixturesByTeam.get(team) ?? fixturesByTeam.set(team, []).get(team)!).push(fx);
    add(f.team_h as number, { gw: f.gw as number, opp: `${short.get(f.team_a as number) ?? "?"} (H)`, fdr: f.custom_fdr_h as number | null });
    add(f.team_a as number, { gw: f.gw as number, opp: `${short.get(f.team_h as number) ?? "?"} (A)`, fdr: f.custom_fdr_a as number | null });
  }

  const byPlayer = new Map<number, ProjRow[]>();
  for (const r of proj) (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)!).push(r);

  // Raw numbers per player.
  const raw = (playersRes.data ?? []).map((p) => {
    const rows = byPlayer.get(p.fpl_id as number) ?? [];
    const xp5 = rows.reduce((s, r) => s + Number(r.x_pts ?? 0), 0);
    const nextRow = rows.find((r) => r.gw === nextGw);
    // Minutes per game: a double gameweek's expected minutes cover two games; blank weeks are skipped.
    const played = rows.filter((r) => r.exp_minutes != null && Number(r.n_fixtures ?? 1) > 0);
    const mins = played.length
      ? played.reduce((s, r) => s + Number(r.exp_minutes) / Math.max(1, Number(r.n_fixtures ?? 1)), 0) / played.length
      : 0;
    const csdef5 = rows.reduce((s, r) => s + Number(r.x_cs_pts ?? 0) + Number(r.x_defcon_pts ?? 0), 0);
    const fixtures = (fixturesByTeam.get(p.team_id as number) ?? []).sort((a, b) => a.gw - b.gw);
    const fdrs = fixtures.map((f) => f.fdr).filter((x): x is number => x != null);
    const price = Number(p.now_cost ?? 0) / 10;
    return {
      id: p.fpl_id as number,
      name: p.web_name as string,
      fullName: (p.full_name as string | null) ?? (p.web_name as string),
      team: short.get(p.team_id as number) ?? "?",
      pos: (p.position as string) ?? "?",
      photo: p.code ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png` : null,
      price,
      own: Number(p.selected_by_percent ?? 0),
      status: (p.status as string) ?? "a",
      chance: p.chance_of_playing_next_round as number | null,
      form: Number(p.form ?? 0),
      totalPts: Number(p.total_points ?? 0),
      minutes: Number(p.minutes ?? 0),
      xg90: Number(p.expected_goals_per_90 ?? 0),
      xa90: Number(p.expected_assists_per_90 ?? 0),
      xp1: Number(nextRow?.x_pts ?? 0),
      xp5,
      start: Number(nextRow?.p_start ?? 0),
      mins,
      csdef5,
      fdr: fdrs.length ? fdrs.reduce((a, b) => a + b, 0) / fdrs.length : null,
      fixtures,
    };
  });

  // The pool every rating is ranked against.
  const pool = raw.filter((p) => p.xp5 >= POOL_MIN_XP5);
  const best = (f: (p: (typeof raw)[number]) => number, from = pool) => Math.max(0, ...from.map(f));
  const B = {
    xp5: best((p) => p.xp5),
    form: best((p) => p.form),
    // xG/xA per 90 from a handful of minutes is noise, so only regulars set the best.
    att: best((p) => p.xg90 + p.xa90, pool.filter((p) => p.minutes >= 270)),
    def: best((p) => p.csdef5),
    val: best((p) => (p.price ? p.xp5 / p.price : 0)),
  };
  const ease = pool.map((p) => (p.fdr == null ? 0 : 6 - p.fdr)).sort((a, b) => a - b);

  const players: ComparePlayer[] = raw
    .filter((p) => p.status !== "u") // left the club or on loan
    .map((p) => ({
      ...p,
      xp1: r1(p.xp1),
      xp5: r1(p.xp5),
      start: r2(p.start),
      mins: Math.round(p.mins),
      csdef5: r1(p.csdef5),
      fdr: p.fdr == null ? null : r2(p.fdr),
      ovr: vsBest(p.xp5, B.xp5, 40),
      attrs: {
        FRM: vsBest(p.form, B.form),
        ATT: vsBest(p.xg90 + p.xa90, B.att),
        DEF: vsBest(p.csdef5, B.def),
        MIN: Math.max(1, Math.min(99, Math.round((p.mins / 90) * 99))),
        FIX: p.fdr == null ? 1 : scale(pct(6 - p.fdr, ease), 30),
        VAL: vsBest(p.price ? p.xp5 / p.price : 0, B.val),
      },
    }))
    .sort((a, b) => b.xp5 - a.xp5);

  return { players, gws };
}
