import { createSupabaseServerClient, type PlayerRow } from "@/lib/supabase";
import { PlayersTable } from "@/components/players-table";

// Always read fresh from the DB at request time.
export const dynamic = "force-dynamic";

const MODEL = "rules-v1";

type ProjRow = { player_id: number; gw: number; x_pts: number | null };

// PostgREST caps a response at 1000 rows; the projections table is larger, so page through it.
async function fetchAllProjections(
  supabase: ReturnType<typeof createSupabaseServerClient>,
): Promise<ProjRow[]> {
  const size = 1000;
  const all: ProjRow[] = [];
  for (let from = 0; ; from += size) {
    const { data } = await supabase
      .from("projections")
      .select("player_id, gw, x_pts")
      .eq("model_version", MODEL)
      .range(from, from + size - 1);
    const batch = (data ?? []) as ProjRow[];
    all.push(...batch);
    if (batch.length < size) break;
  }
  return all;
}

export default async function PlayersPage() {
  const supabase = createSupabaseServerClient();

  const [playersRes, teamsRes] = await Promise.all([
    supabase
      .from("players")
      .select(
        "fpl_id, web_name, position, now_cost, selected_by_percent, total_points, status, team_id, team:teams(short_name, name)",
      ),
    supabase.from("teams").select("fpl_id, short_name"),
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
  const nextGw = projections.length ? Math.min(...projections.map((p) => p.gw)) : null;

  // Aggregate projections per player: next-GW xPts and 5-GW total.
  const projByPlayer = new Map<number, { xp_next: number | null; xp5: number }>();
  for (const r of projections) {
    const e = projByPlayer.get(r.player_id) ?? { xp_next: null, xp5: 0 };
    e.xp5 += r.x_pts ?? 0;
    if (r.gw === nextGw) e.xp_next = r.x_pts ?? null;
    projByPlayer.set(r.player_id, e);
  }

  // Next-GW opponent + custom FDR per team.
  const shortById = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id, t.short_name]));
  const oppByTeam = new Map<number, { opp: string; fdr: number | null }>();
  if (nextGw != null) {
    const { data: fixtures } = await supabase
      .from("fixtures")
      .select("team_h, team_a, custom_fdr_h, custom_fdr_a")
      .eq("gw", nextGw);
    for (const f of fixtures ?? []) {
      oppByTeam.set(f.team_h, { opp: shortById.get(f.team_a) ?? "?", fdr: f.custom_fdr_h });
      oppByTeam.set(f.team_a, { opp: `@${shortById.get(f.team_h) ?? "?"}`, fdr: f.custom_fdr_a });
    }
  }

  const rows: PlayerRow[] = (playersRes.data ?? []).map((p) => {
    const pr = projByPlayer.get(p.fpl_id);
    const opp = p.team_id != null ? oppByTeam.get(p.team_id) : undefined;
    return {
      ...(p as unknown as PlayerRow),
      xp_next: pr?.xp_next ?? null,
      xp5: pr ? Number(pr.xp5.toFixed(2)) : null,
      opp: opp?.opp ?? null,
      opp_fdr: opp?.fdr ?? null,
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
        <p className="text-sm text-muted-foreground">
          Projected expected points (xPts) for every player, fixture-adjusted. Sort by xPts to find value.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm"
          >
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
