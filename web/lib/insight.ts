import { createSupabaseServerClient, MODEL_VERSION } from "@/lib/supabase";

// Builds the "i" pop-up for a player: every bullet traces to a number the worker stored on the
// projection (components.why and friends — see worker/fpl_worker/model.py), so the explanation always
// matches what the model actually used.

export type InsightSection = { title: string; bullets: string[] };
export type Insight = {
  player: { id: number; name: string; team: string; position: string; price: number; ownership: number };
  sections: InsightSection[];
};

export const DIFFERENTIAL_OWNERSHIP = 10; // % owned — below this a pick is a differential
export const TEMPLATE_OWNERSHIP = 30; // % owned — above this a pick is "template"
const HORIZON = 5;

const STATUS: Record<string, string> = {
  a: "Available",
  d: "Doubtful",
  i: "Injured",
  s: "Suspended",
  u: "Unavailable (left the club or on loan)",
  n: "Not in the squad",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

type Why = {
  start_rate: number;
  p60_start: number;
  recent_starts: number;
  recent_games: number;
  recent_minutes: number;
  fpl_avail: number;
  news_adj: number;
  avail: number;
  xg_share?: number;
  xa_share?: number;
  bonus90?: number;
  home_mult?: { home: number; away: number };
  price?: { net: number; pressure: number; p_rise: number; p_fall: number };
  return?: { base: number; ramp: number; absent: number } | null;
  manager_reset?: boolean;
  setpieces?: { pen: boolean; corner: boolean; fk: boolean };
  xg90?: number; // older projections (before the role-share model)
  xa90?: number;
  dc90: number;
  season: { xg: number; xa: number; min: number };
  last: { xg: number; xa: number; min: number } | null;
};
type Comp = {
  opponents?: string[];
  form?: number;
  team_xg_for?: number[];
  team_xg_against?: number[];
  odds?: boolean[];
  atk_mult?: number[];
  p_cs?: number[];
  p_start?: number;
  p_60?: number;
  exp_minutes?: number;
  p_dc?: number;
  calibration?: number;
  rest_days?: (number | null)[];
  lineup?: [boolean, number] | null;
  f?: Record<string, { base: number; term: number } | null>;
  why?: Why;
};
type ProjRow = {
  player_id: number;
  gw: number;
  x_pts: number;
  x_appearance_pts: number;
  x_goals_pts: number;
  x_assist_pts: number;
  x_cs_pts: number;
  x_saves_pts: number;
  x_defcon_pts: number;
  x_bonus_pts: number;
  x_deductions_pts: number;
  components: Comp | null;
};

export async function buildInsight(playerId: number): Promise<Insight | null> {
  const sb = createSupabaseServerClient();
  const { data: p } = await sb
    .from("players")
    .select(
      "fpl_id, web_name, position, now_cost, selected_by_percent, status, chance_of_playing_next_round, news, minutes, team:teams(short_name, name)",
    )
    .eq("fpl_id", playerId)
    .maybeSingle();
  if (!p) return null;

  const { data: first } = await sb
    .from("projections")
    .select("gw")
    .eq("model_version", MODEL_VERSION)
    .order("gw", { ascending: true })
    .limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;

  const [{ data: projs }, { data: newsRows }, { data: posRows }, { data: params }] = await Promise.all([
    sb
      .from("projections")
      .select("*")
      .eq("model_version", MODEL_VERSION)
      .eq("player_id", playerId)
      .gte("gw", nextGw ?? 0)
      .lt("gw", (nextGw ?? 0) + HORIZON)
      .order("gw"),
    sb
      .from("news_sentiment")
      .select("sentiment, topics, summary, minutes_risk_adj, url, source, published_at")
      .eq("player_id", playerId)
      .order("published_at", { ascending: false })
      .limit(1),
    // Everyone at the same position, for "ranks #N of M" over the next 5 GWs.
    sb.from("players").select("fpl_id").eq("position", p.position ?? ""),
    sb.from("model_params").select("key, value").eq("key", "news_weight"),
  ]);
  const rows = (projs ?? []) as ProjRow[];
  const next = rows.find((r) => r.gw === nextGw) ?? null;
  const c: Comp = next?.components ?? {};
  const why = c.why;
  const team = p.team as { short_name?: string; name?: string } | null;
  const ownership = Number(p.selected_by_percent ?? 0);
  const price = (p.now_cost ?? 0) / 10;
  const xp5 = rows.reduce((s, r) => s + (r.x_pts ?? 0), 0);

  // Position rank over the horizon.
  let rank: { n: number; of: number } | null = null;
  const ids = (posRows ?? []).map((r) => r.fpl_id as number);
  if (nextGw != null && ids.length) {
    const totals = new Map<number, number>();
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("projections")
        .select("player_id, x_pts")
        .eq("model_version", MODEL_VERSION)
        .gte("gw", nextGw)
        .lt("gw", nextGw + HORIZON)
        .in("player_id", ids)
        .order("player_id")
        .range(from, from + 999);
      for (const r of data ?? []) totals.set(r.player_id, (totals.get(r.player_id) ?? 0) + (r.x_pts ?? 0));
      if ((data ?? []).length < 1000) break;
    }
    const better = [...totals.values()].filter((v) => v > xp5).length;
    rank = { n: better + 1, of: totals.size };
  }

  const sections: InsightSection[] = [];

  // 1. Projection
  const proj: string[] = [];
  if (next) {
    const opp = (c.opponents ?? []).map((o) => (o.startsWith("@") ? `${o.slice(1)} (away)` : `${o} (home)`)).join(" & ");
    proj.push(`${f1(next.x_pts)} pts projected in GW${next.gw}${opp ? ` vs ${opp}` : ""}`);
  } else if (nextGw != null) {
    proj.push(`No fixture in GW${nextGw} (blank gameweek)`);
  }
  if (rows.length) proj.push(`${f1(xp5)} pts over the next ${HORIZON} GWs`);
  if (rank) proj.push(`Ranks #${rank.n} of ${rank.of} ${p.position}s over the next ${HORIZON} GWs`);
  if (rows.length > 1) proj.push(`By GW: ${rows.map((r) => `GW${r.gw} ${f1(r.x_pts)}`).join(" · ")}`);
  sections.push({ title: "Projection", bullets: proj });

  // 2. Minutes & availability
  const mins: string[] = [`Status: ${STATUS[p.status ?? "a"] ?? "Available"}`];
  if (p.chance_of_playing_next_round != null) mins.push(`FPL chance of playing: ${p.chance_of_playing_next_round}%`);
  if (p.news) mins.push(`FPL news: ${p.news}`);
  if (why) {
    if (why.recent_games > 0)
      mins.push(
        `Started ${why.recent_starts} of his club's last ${why.recent_games} games (${why.recent_minutes} min)`,
      );
    mins.push(`Start rate from recent games: ${pct(why.start_rate)} (recent games count most)`);
    if (why.return)
      mins.push(`Back from a ${why.return.absent}-game absence: start rate eased back to ${pct(why.return.ramp)} (was ${pct(why.return.base)} from the missed games)`);
    if (c.lineup)
      mins.push(
        c.lineup[0]
          ? `Named in the predicted XI for this GW (source confidence ${pct(c.lineup[1])})`
          : `Left out of the predicted XI for this GW (source confidence ${pct(c.lineup[1])})`,
      );
    const rest = (c.rest_days ?? []).find((d) => d != null);
    if (rest != null && rest <= 3) mins.push(`Club plays again within ${rest} days of this game: rotation risk lowers his start chance`);
    if (why.manager_reset) mins.push("New manager recently: games under the previous manager count less");
    if (c.p_start != null) mins.push(`Chance of starting this GW: ${pct(c.p_start)}`);
    if (c.p_60 != null) mins.push(`Chance of 60+ minutes: ${pct(c.p_60)}`);
    if (c.exp_minutes != null) mins.push(`Expected minutes: ${Math.round(c.exp_minutes)}`);
  }
  sections.push({ title: "Minutes & availability", bullets: mins });

  // 3. News
  const news = newsRows?.[0];
  if (news) {
    const nb: string[] = [];
    const topics = (news.topics ?? []).filter((t: string) => t !== "none");
    nb.push(`Tone: ${news.sentiment ?? "neutral"}${topics.length ? ` · ${topics.join(", ")}` : ""}`);
    if (news.summary) nb.push(news.summary);
    if (why && why.news_adj < 0) {
      const w = Number(params?.[0]?.value ?? 1);
      const cut = Math.min(1, -why.news_adj * w);
      nb.push(
        why.avail < why.fpl_avail
          ? `Cuts his availability by ${pct(cut)} (news is more cautious than FPL's flag)`
          : `Already covered by FPL's own flag, so no extra cut`,
      );
    } else {
      nb.push("No effect on his minutes");
    }
    if (news.source || news.published_at)
      nb.push(
        `Source: ${news.source ?? "Google News"}${news.published_at ? `, ${new Date(news.published_at).toDateString()}` : ""}`,
      );
    sections.push({ title: "News", bullets: nb });
  }

  // 4. Form
  if (why) {
    const fb: string[] = [];
    if (why.xg_share != null) {
      fb.push(`Takes ${pct(why.xg_share)} of his team's chances (xG) while he's on the pitch`);
      fb.push(`Creates ${pct(why.xa_share ?? 0)} of his team's xG as assists (xA)`);
      fb.push("Measured against what his team created in each game, so an easy or hard fixture doesn't inflate or hide it");
    } else if (why.xg90 != null) {
      fb.push(`Goal threat used: ${f2(why.xg90)} xG per 90 · creativity ${f2(why.xa90 ?? 0)} xA per 90`);
    }
    fb.push(`This season: ${f1(why.season.xg)} xG, ${f1(why.season.xa)} xA in ${why.season.min} min`);
    if (why.last) fb.push(`Last season: ${f1(why.last.xg)} xG, ${f1(why.last.xa)} xA in ${why.last.min} min (counts less than this season)`);
    else fb.push("No last-season Premier League data (new to the league or promoted)");
    fb.push("Pulled toward the average for his position, more so when minutes are few");
    if (why.home_mult && (Math.abs(why.home_mult.home - 1) >= 0.03 || Math.abs(why.home_mult.away - 1) >= 0.03))
      fb.push(`Home/away: ×${f2(why.home_mult.home)} at home, ×${f2(why.home_mult.away)} away (his own split)`);
    if (why.bonus90 != null) fb.push(`Bonus: ${f2(why.bonus90)} bonus points per 90 from his own record`);
    const pen = c.f?.penalty;
    if (why.setpieces?.pen) fb.push(`First-choice penalty taker${pen ? `: +${f2(pen.term)} expected goals this GW (learned weight applied)` : ""}`);
    const sp = c.f?.setpiece;
    if (why.setpieces?.corner || why.setpieces?.fk)
      fb.push(
        `Takes ${[why.setpieces.corner ? "corners" : "", why.setpieces.fk ? "direct free kicks" : ""].filter(Boolean).join(" and ")}${sp ? `: +${f2(sp.term)} expected goals/assists` : ""}`,
      );
    if (c.form != null && c.form !== 1) fb.push(`Preseason World Cup form: ×${c.form}`);
    if ((p.position === "DEF" || p.position === "MID" || p.position === "FWD") && why.dc90 > 0)
      fb.push(`Defensive actions: ${f1(why.dc90)} per 90${c.p_dc != null ? ` → ${pct(c.p_dc)} chance of the DefCon bonus per start` : ""}`);
    sections.push({ title: "Form", bullets: fb });
  }

  // 5. Fixture
  if (next && c.team_xg_for?.length) {
    const fx: string[] = [];
    (c.opponents ?? []).forEach((o, i) => {
      const where = o.startsWith("@") ? "away at" : "home to";
      fx.push(
        `${where} ${o.replace("@", "")}: ${team?.short_name ?? "his team"} expected to score ${f2(c.team_xg_for![i])}, concede ${f2(c.team_xg_against![i])}${c.odds?.[i] ? " (bookmaker odds blended in)" : " (team-strength model)"}`,
      );
      if (c.atk_mult?.[i] != null) {
        const m = c.atk_mult[i];
        fx.push(`Attacking outlook ×${f2(m)} vs his team's average${m >= 1.1 ? " (favourable)" : m <= 0.9 ? " (tough)" : ""}`);
      }
      if (c.p_cs?.[i] != null && p.position !== "FWD") fx.push(`Clean-sheet chance: ${pct(c.p_cs[i])}`);
    });
    if (c.calibration != null && c.calibration !== 1) fx.push(`Position calibration ×${c.calibration} from past accuracy`);
    sections.push({ title: "Fixture", bullets: fx });
  }

  // 6. Points breakdown
  if (next) {
    const parts: [string, number][] = [
      ["Appearance", next.x_appearance_pts],
      ["Goals", next.x_goals_pts],
      ["Assists", next.x_assist_pts],
      ["Clean sheet", next.x_cs_pts],
      ["Defensive contributions", next.x_defcon_pts],
      ["Saves", next.x_saves_pts],
      ["Bonus", next.x_bonus_pts],
      ["Deductions (cards, goals conceded)", next.x_deductions_pts],
    ];
    sections.push({
      title: `Where the GW${next.gw} points come from`,
      bullets: parts.filter(([, v]) => Math.abs(v ?? 0) >= 0.05).map(([k, v]) => `${k}: ${v > 0 ? "+" : ""}${f2(v)}`),
    });
  }

  // 7. Price & ownership
  const own: string[] = [`Price £${f1(price)}m`, `Owned by ${f1(ownership)}% of managers`];
  if (xp5 > 0) own.push(`Value: ${f2(xp5 / price)} projected pts per £m over ${HORIZON} GWs`);
  if (why?.price) {
    const pr = why.price;
    own.push(`Net transfers this GW: ${pr.net >= 0 ? "+" : ""}${pr.net.toLocaleString()} (${(pr.pressure * 100).toFixed(1)}% of owners)`);
    if (pr.p_rise >= 0.05) own.push(`About ${pct(pr.p_rise)} chance of a price rise before the next deadline (from past seasons)`);
    else if (pr.p_fall >= 0.05) own.push(`About ${pct(pr.p_fall)} chance of a price fall before the next deadline (from past seasons)`);
    else own.push("Price change unlikely before the next deadline");
  }
  if (ownership < DIFFERENTIAL_OWNERSHIP) own.push("Differential: a haul gains you rank on most rivals");
  else if (ownership > TEMPLATE_OWNERSHIP) own.push("Template pick: owning him protects your rank");
  sections.push({ title: "Price & ownership", bullets: own });

  return {
    player: {
      id: p.fpl_id,
      name: p.web_name,
      team: team?.short_name ?? "?",
      position: p.position ?? "?",
      price,
      ownership,
    },
    sections,
  };
}
