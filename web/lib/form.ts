import type { SupabaseClient } from "@supabase/supabase-js";
import { MODEL_VERSION } from "@/lib/supabase";

// Scout → Form: which clubs and players are in form, from FPL's own results (fixtures feed: scores and
// scorers) and player form (bootstrap-static), read server-side and cached for an hour. Hot picks add the
// model's projections. Every number is a count or an average of real results; nothing is estimated.

const FPL = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 fpl-selector (personal FPL tool)";
export const FORM_GAMES = 6; // "recent" = each club's last 6 league games
const PICK_GWS = 3; // hot picks: projected points over the next 3 GWs
const POS = ["", "GK", "DEF", "MID", "FWD"] as const;

type StatList = { value: number; element: number }[];
type FplFixture = {
  id: number; event: number | null; team_h: number; team_a: number; team_h_score: number | null; team_a_score: number | null;
  finished: boolean; kickoff_time: string | null; stats: { identifier: string; h: StatList; a: StatList }[];
};
type FplTeam = { id: number; code: number; name: string; short_name: string };
type FplEl = {
  id: number; web_name: string; team: number; element_type: number; now_cost: number; status: string;
  form: string; selected_by_percent: string; minutes: number; total_points: number;
  expected_goal_involvements_per_90: number | string;
};

async function fpl<T>(path: string): Promise<T> {
  const res = await fetch(`${FPL}/${path}`, { headers: { "User-Agent": UA, Accept: "application/json" }, next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`FPL ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export type Result = { gw: number | null; opp: string; home: boolean; gf: number; ga: number; res: "W" | "D" | "L"; scorers: string[] };
export type Upcoming = { gw: number; opp: string; home: boolean; fdr: number | null };
export type FormPlayer = {
  id: number; name: string; team: string; teamId: number; pos: string; price: number; own: number; status: string;
  form: number; goals: number; assists: number; bonus: number; mins: number; xgi90: number; xp: number; hot: boolean;
};
export type TeamForm = {
  id: number; name: string; short: string; crest: string;
  recent: Result[]; pts: number; ppg: number; gf: number; ga: number; cs: number; // over the last FORM_GAMES
  seasonPpg: number; seasonGf: number; seasonGa: number; played: number;
  formRank: number; attackRank: number; defenceRank: number;
  tags: { label: string; tone: "good" | "bad" | "neutral" }[];
  strengths: string[]; weaknesses: string[];
  next: Upcoming[];
};

const per = (n: number, d: number) => (d ? n / d : 0);
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export async function getForm(sb: SupabaseClient): Promise<{ teams: TeamForm[]; players: FormPlayer[]; gws: number }> {
  const [fixtures, boot] = await Promise.all([
    fpl<FplFixture[]>("fixtures/"),
    fpl<{ teams: FplTeam[]; elements: FplEl[] }>("bootstrap-static/"),
  ]);
  const short = new Map(boot.teams.map((t) => [t.id, t.short_name]));
  const el = new Map(boot.elements.map((e) => [e.id, e]));
  const done = fixtures
    .filter((f) => f.finished && f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => (a.kickoff_time ?? "").localeCompare(b.kickoff_time ?? ""));

  // Each club's games, oldest first; and player tallies over his club's last FORM_GAMES.
  const games = new Map<number, { f: FplFixture; home: boolean }[]>();
  for (const f of done) {
    for (const [tid, home] of [[f.team_h, true], [f.team_a, false]] as const) {
      if (!games.has(tid)) games.set(tid, []);
      games.get(tid)!.push({ f, home });
    }
  }
  const tally = new Map<number, { goals: number; assists: number; bonus: number }>();
  const add = (id: number, k: "goals" | "assists" | "bonus", v: number) => {
    const t = tally.get(id) ?? { goals: 0, assists: 0, bonus: 0 };
    t[k] += v;
    tally.set(id, t);
  };

  const teams: TeamForm[] = boot.teams.map((t) => {
    const all = games.get(t.id) ?? [];
    const last = all.slice(-FORM_GAMES);
    const recent: Result[] = last.map(({ f, home }) => {
      const gf = (home ? f.team_h_score : f.team_a_score) ?? 0;
      const ga = (home ? f.team_a_score : f.team_h_score) ?? 0;
      const side = home ? "h" : "a";
      const stat = (id: string) => f.stats.find((s) => s.identifier === id)?.[side] ?? [];
      for (const s of stat("goals_scored")) add(s.element, "goals", s.value);
      for (const s of stat("assists")) add(s.element, "assists", s.value);
      for (const s of stat("bonus")) add(s.element, "bonus", s.value);
      const scorers = stat("goals_scored").map((s) => `${el.get(s.element)?.web_name ?? "?"}${s.value > 1 ? ` ×${s.value}` : ""}`);
      return {
        gw: f.event, opp: short.get(home ? f.team_a : f.team_h) ?? "?", home, gf, ga,
        res: gf > ga ? "W" : gf === ga ? "D" : "L", scorers,
      };
    });
    const pts = recent.reduce((s, r) => s + (r.res === "W" ? 3 : r.res === "D" ? 1 : 0), 0);
    const seasonPts = all.reduce((s, { f, home }) => {
      const gf = (home ? f.team_h_score : f.team_a_score) ?? 0;
      const ga = (home ? f.team_a_score : f.team_h_score) ?? 0;
      return s + (gf > ga ? 3 : gf === ga ? 1 : 0);
    }, 0);
    const sumG = (rows: { f: FplFixture; home: boolean }[], forSide: boolean) =>
      rows.reduce((s, { f, home }) => s + ((home === forSide ? f.team_h_score : f.team_a_score) ?? 0), 0);
    const n = recent.length;
    return {
      id: t.id, name: t.name, short: t.short_name, recent, pts,
      crest: `https://resources.premierleague.com/premierleague/badges/70/t${t.code}.png`,
      ppg: per(pts, n), gf: per(recent.reduce((s, r) => s + r.gf, 0), n), ga: per(recent.reduce((s, r) => s + r.ga, 0), n),
      cs: recent.filter((r) => r.ga === 0).length,
      seasonPpg: per(seasonPts, all.length), seasonGf: per(sumG(all, true), all.length), seasonGa: per(sumG(all, false), all.length),
      played: all.length, formRank: 0, attackRank: 0, defenceRank: 0, tags: [], strengths: [], weaknesses: [], next: [],
    };
  });

  // Ranks over the last FORM_GAMES (1 = best), then plain-English tags and strengths from those ranks.
  const rankBy = (key: (t: TeamForm) => number, set: (t: TeamForm, r: number) => void) =>
    [...teams].sort((a, b) => key(b) - key(a)).forEach((t, i) => set(t, i + 1));
  rankBy((t) => t.pts * 100 + (t.gf - t.ga), (t, r) => (t.formRank = r));
  rankBy((t) => t.gf, (t, r) => (t.attackRank = r));
  rankBy((t) => -t.ga, (t, r) => (t.defenceRank = r));
  const g = FORM_GAMES;
  for (const t of teams) {
    const trend = t.ppg - t.seasonPpg;
    if (t.attackRank <= 4) t.tags.push({ label: "Scoring freely", tone: "good" });
    if (t.attackRank >= 17) t.tags.push({ label: "Goal-shy", tone: "bad" });
    if (t.defenceRank <= 4) t.tags.push({ label: "Tight defence", tone: "good" });
    if (t.defenceRank >= 17) t.tags.push({ label: "Leaky", tone: "bad" });
    if (trend >= 0.4) t.tags.push({ label: "Improving", tone: "good" });
    if (trend <= -0.4) t.tags.push({ label: "Slumping", tone: "bad" });
    const unbeaten = t.recent.every((r) => r.res !== "L");
    if (unbeaten && t.recent.length >= 4) t.tags.push({ label: `Unbeaten in ${t.recent.length}`, tone: "good" });

    const s = t.strengths, w = t.weaknesses;
    // Top 8 of 20 counts as a strength, bottom 8 as a weak spot; the middle isn't called either way.
    const side = (rank: number) => (rank <= 8 ? s : rank >= 13 ? w : null);
    side(t.formRank)?.push(`${t.pts} pts from the last ${t.recent.length}: ${ord(t.formRank)} of 20 over that run`);
    side(t.attackRank)?.push(
      `${t.gf.toFixed(1)} goals a game: ${ord(t.attackRank)} of 20 for attack over the last ${g} (season ${t.seasonGf.toFixed(1)})`,
    );
    side(t.defenceRank)?.push(
      `${t.ga.toFixed(1)} conceded a game: ${ord(t.defenceRank)} of 20 for defence over the last ${g} (season ${t.seasonGa.toFixed(1)})`,
    );
    if (t.cs >= 2) s.push(`${t.cs} clean sheets in ${t.recent.length}`);
    else if (t.cs === 0 && t.recent.length) w.push(`No clean sheet in ${t.recent.length}`);
    if (trend >= 0.4) s.push(`Picking up ${t.ppg.toFixed(1)} pts a game, up from ${t.seasonPpg.toFixed(1)} across the season`);
    if (trend <= -0.4) w.push(`Down to ${t.ppg.toFixed(1)} pts a game, from ${t.seasonPpg.toFixed(1)} across the season`);
    const blanks = t.recent.filter((r) => r.gf === 0).length;
    if (blanks >= 2) w.push(`Failed to score in ${blanks} of the last ${t.recent.length}`);
  }

  // Upcoming fixtures (our custom difficulty) and the next GW with projections.
  const { data: first } = await sb.from("projections").select("gw").eq("model_version", MODEL_VERSION).order("gw").limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;
  if (nextGw != null) {
    const { data: fx } = await sb
      .from("fixtures")
      .select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, team_h_difficulty, team_a_difficulty")
      .gte("gw", nextGw).lt("gw", nextGw + PICK_GWS).order("gw");
    for (const f of fx ?? []) {
      const h = teams.find((t) => t.id === f.team_h);
      const a = teams.find((t) => t.id === f.team_a);
      h?.next.push({ gw: f.gw, opp: a?.short ?? "?", home: true, fdr: Number(f.custom_fdr_h ?? f.team_h_difficulty) || null });
      a?.next.push({ gw: f.gw, opp: h?.short ?? "?", home: false, fdr: Number(f.custom_fdr_a ?? f.team_a_difficulty) || null });
    }
  }

  // Projected points over the next PICK_GWS, for hot picks.
  const xp = new Map<number, number>();
  if (nextGw != null) {
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("projections").select("player_id, x_pts").eq("model_version", MODEL_VERSION)
        .gte("gw", nextGw).lt("gw", nextGw + PICK_GWS).order("player_id").order("gw").range(from, from + 999);
      for (const r of data ?? []) xp.set(r.player_id, (xp.get(r.player_id) ?? 0) + Number(r.x_pts ?? 0));
      if ((data ?? []).length < 1000) break;
    }
  }

  const players: FormPlayer[] = boot.elements
    .filter((e) => e.minutes > 0)
    .map((e) => {
      const t = tally.get(e.id) ?? { goals: 0, assists: 0, bonus: 0 };
      return {
        id: e.id, name: e.web_name, team: short.get(e.team) ?? "?", teamId: e.team, pos: POS[e.element_type] ?? "?",
        price: e.now_cost / 10, own: Number(e.selected_by_percent), status: e.status, form: Number(e.form),
        goals: t.goals, assists: t.assists, bonus: t.bonus, mins: e.minutes,
        xgi90: Number(e.expected_goal_involvements_per_90), xp: xp.get(e.id) ?? 0, hot: false,
      };
    });
  // Hot pick: in form (FPL form 5+) AND among the top 40 projections for the next PICK_GWS, and available.
  const xpCut = [...players].sort((a, b) => b.xp - a.xp)[39]?.xp ?? Infinity;
  for (const p of players) p.hot = p.form >= 5 && p.xp >= xpCut && p.status === "a";

  return { teams: teams.sort((a, b) => a.formRank - b.formRank), players, gws: PICK_GWS };
}
