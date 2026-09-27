import {
  MODEL_VERSION,
  createSupabaseServerClient,
  type BreakdownComponent,
  type NewsSignal,
  type PlayerRow,
} from "@/lib/supabase";
import { PlayersTable } from "@/components/players-table";

// Always read fresh from the DB at request time.
export const dynamic = "force-dynamic";

const MODEL = MODEL_VERSION;

type ProjRow = {
  player_id: number;
  gw: number;
  x_pts: number | null;
  x_appearance_pts: number | null;
  x_goals_pts: number | null;
  x_assist_pts: number | null;
  x_cs_pts: number | null;
  x_saves_pts: number | null;
  x_defcon_pts: number | null;
  x_bonus_pts: number | null;
  x_deductions_pts: number | null;
};

const PROJ_COLUMNS =
  "player_id, gw, x_pts, x_appearance_pts, x_goals_pts, x_assist_pts, x_cs_pts, x_saves_pts, x_defcon_pts, x_bonus_pts, x_deductions_pts";

// The table shows the next 5 GWs ("xp5" and the per-GW schedule), so fetch only those — the projections
// table holds every GW to 38 (~22k rows). PostgREST caps a response at 1000 rows, so page through it.
const SHOWN_GWS = 5;
async function fetchAllProjections(
  supabase: ReturnType<typeof createSupabaseServerClient>,
): Promise<ProjRow[]> {
  const { data: first } = await supabase
    .from("projections")
    .select("gw")
    .eq("model_version", MODEL)
    .order("gw", { ascending: true })
    .limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;
  if (nextGw == null) return [];
  const size = 1000;
  const all: ProjRow[] = [];
  for (let from = 0; ; from += size) {
    const { data } = await supabase
      .from("projections")
      .select(PROJ_COLUMNS)
      .eq("model_version", MODEL)
      .gte("gw", nextGw)
      .lt("gw", nextGw + SHOWN_GWS)
      .order("player_id")
      .order("gw")
      .range(from, from + size - 1);
    const batch = (data ?? []) as ProjRow[];
    all.push(...batch);
    if (batch.length < size) break;
  }
  return all;
}

function components(r: ProjRow): BreakdownComponent[] {
  return [
    { label: "Appearance", value: r.x_appearance_pts ?? 0 },
    { label: "Goals", value: r.x_goals_pts ?? 0 },
    { label: "Assists", value: r.x_assist_pts ?? 0 },
    { label: "Clean sheet", value: r.x_cs_pts ?? 0 },
    { label: "Bonus", value: r.x_bonus_pts ?? 0 },
    { label: "DefCon", value: r.x_defcon_pts ?? 0 },
    { label: "Saves", value: r.x_saves_pts ?? 0 },
    { label: "Deductions", value: r.x_deductions_pts ?? 0 },
  ];
}

export default async function PlayersPage() {
  const supabase = createSupabaseServerClient();

  const [playersRes, teamsRes, newsRes] = await Promise.all([
    supabase
      .from("players")
      .select(
        "fpl_id, web_name, position, now_cost, selected_by_percent, total_points, status, team_id, team:teams(short_name, name)",
      ),
    supabase.from("teams").select("fpl_id, short_name"),
    supabase
      .from("news_sentiment")
      .select("player_id, sentiment, topics, summary, minutes_risk_adj, url, source, published_at"),
  ]);

  if (playersRes.error) {
    return (
      <main className="mx-auto w-full max-w-7xl px-6 py-8">
        <p className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          Failed to load players: {playersRes.error.message}
        </p>
      </main>
    );
  }

  const projections = await fetchAllProjections(supabase);
  const gws = [...new Set(projections.map((p) => p.gw))].sort((a, b) => a - b);
  const nextGw = gws.length ? gws[0] : null;

  // Aggregate projections per player.
  const proj = new Map<
    number,
    { xp_next: number | null; xp5: number; comps: BreakdownComponent[] | null; xpByGw: Map<number, number> }
  >();
  for (const r of projections) {
    const e = proj.get(r.player_id) ?? { xp_next: null, xp5: 0, comps: null, xpByGw: new Map() };
    e.xp5 += r.x_pts ?? 0;
    e.xpByGw.set(r.gw, r.x_pts ?? 0);
    if (r.gw === nextGw) {
      e.xp_next = r.x_pts ?? null;
      e.comps = components(r);
    }
    proj.set(r.player_id, e);
  }

  // Advisory news/sentiment signal per player (Phase 7).
  const newsByPlayer = new Map<number, NewsSignal>(
    (newsRes.data ?? []).map((n) => [
      n.player_id as number,
      {
        sentiment: n.sentiment,
        topics: n.topics,
        summary: n.summary,
        minutes_risk_adj: n.minutes_risk_adj,
        url: n.url,
        source: n.source,
        published_at: n.published_at,
      },
    ]),
  );

  // Opponent + custom FDR per team, per GW across the horizon.
  const shortById = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id, t.short_name]));
  const oppByTeamGw = new Map<number, Map<number, { opp: string; fdr: number | null }>>();
  if (gws.length) {
    const { data: fixtures } = await supabase
      .from("fixtures")
      .select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a")
      .in("gw", gws);
    for (const f of fixtures ?? []) {
      if (!oppByTeamGw.has(f.team_h)) oppByTeamGw.set(f.team_h, new Map());
      if (!oppByTeamGw.has(f.team_a)) oppByTeamGw.set(f.team_a, new Map());
      oppByTeamGw.get(f.team_h)!.set(f.gw, { opp: shortById.get(f.team_a) ?? "?", fdr: f.custom_fdr_h });
      oppByTeamGw.get(f.team_a)!.set(f.gw, { opp: `@${shortById.get(f.team_h) ?? "?"}`, fdr: f.custom_fdr_a });
    }
  }

  const rows: PlayerRow[] = (playersRes.data ?? []).map((p) => {
    const pr = proj.get(p.fpl_id);
    const teamGw = p.team_id != null ? oppByTeamGw.get(p.team_id) : undefined;
    const next = nextGw != null ? teamGw?.get(nextGw) : undefined;
    const schedule = pr
      ? gws.map((gw) => {
          const fx = teamGw?.get(gw);
          return { gw, xp: pr.xpByGw.get(gw) ?? 0, opp: fx?.opp ?? null, fdr: fx?.fdr ?? null };
        })
      : null;
    return {
      ...(p as unknown as PlayerRow),
      xp_next: pr?.xp_next ?? null,
      xp5: pr ? Number(pr.xp5.toFixed(2)) : null,
      opp: next?.opp ?? null,
      opp_fdr: next?.fdr ?? null,
      components: pr?.comps ?? null,
      schedule,
      news: newsByPlayer.get(p.fpl_id) ?? null,
    };
  });

  const topPick = rows.reduce<PlayerRow | null>(
    (best, r) => ((r.xp_next ?? -1) > (best?.xp_next ?? -1) ? r : best),
    null,
  );

  const stats = [
    { label: "Players", value: String(rows.length) },
    { label: "Gameweek", value: nextGw != null ? `GW${nextGw}` : "—" },
    {
      label: "Top xPts pick",
      value: topPick ? topPick.web_name : "—",
      sub: topPick?.xp_next != null ? `${topPick.xp_next.toFixed(1)} pts` : undefined,
    },
    { label: "Model", value: MODEL },
  ];

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Player Explorer</h1>
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          <li>• Projected points (xPts) for every player, adjusted for minutes, form and fixtures</li>
          <li>• Click a row for the breakdown; tap the i for the full reasoning</li>
        </ul>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 truncate text-lg font-semibold">{s.value}</div>
            {s.sub ? <div className="text-xs text-muted-foreground">{s.sub}</div> : null}
          </div>
        ))}
      </div>

      <div className="mt-6">
        <PlayersTable players={rows} nextGw={nextGw} />
      </div>
    </main>
  );
}
