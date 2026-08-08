import { createSupabaseServerClient, type Position } from "@/lib/supabase";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";

export const dynamic = "force-dynamic";

const MODEL = "rules-v1";
const CHIP_LABEL: Record<string, string> = {
  wildcard: "Wildcard",
  freehit: "Free Hit",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
  manager: "Assistant Manager",
};

type Pick = {
  element: number;
  position: number;
  is_captain: boolean;
  is_vice_captain: boolean;
};

export default async function TeamPage() {
  const supabase = createSupabaseServerClient();

  const { data: stateRows } = await supabase
    .from("user_team_state")
    .select("*")
    .eq("user_id", "me")
    .order("gw", { ascending: false })
    .limit(1);
  const state = stateRows?.[0];
  const picks = (state?.picks ?? []) as Pick[];

  if (!state || picks.length === 0) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">My Team</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          No squad synced yet. Run the worker <code>sync_team</code> once a gameweek has started.
        </p>
      </main>
    );
  }

  const els = picks.map((p) => p.element);
  const [playersRes, projRes] = await Promise.all([
    supabase
      .from("players")
      .select("fpl_id, web_name, position, now_cost, status, team:teams(short_name)")
      .in("fpl_id", els),
    supabase
      .from("projections")
      .select("player_id, gw, x_pts")
      .eq("model_version", MODEL)
      .in("player_id", els),
  ]);

  const projs = projRes.data ?? [];
  const nextGw = projs.length ? Math.min(...projs.map((p) => p.gw)) : null;
  const xpByPlayer = new Map<number, number>();
  for (const r of projs) if (r.gw === nextGw) xpByPlayer.set(r.player_id, r.x_pts ?? 0);
  const pmap = new Map((playersRes.data ?? []).map((p) => [p.fpl_id, p as Record<string, unknown>]));

  const squad = picks.map((pk) => {
    const pl = pmap.get(pk.element);
    const team = pl?.team as { short_name?: string } | null | undefined;
    return {
      fpl_id: pk.element,
      web_name: (pl?.web_name as string) ?? "?",
      position: (pl?.position as Position | null) ?? null,
      team_short: team?.short_name ?? "",
      now_cost: (pl?.now_cost as number) ?? null,
      status: (pl?.status as string) ?? null,
      is_captain: pk.is_captain,
      is_vice_captain: pk.is_vice_captain,
      xp_next: xpByPlayer.get(pk.element) ?? null,
      pick_position: pk.position,
    } satisfies SquadPlayer & { pick_position: number };
  });

  const starting = squad.filter((s) => s.pick_position <= 11);
  const bench = squad
    .filter((s) => s.pick_position > 11)
    .sort((a, b) => a.pick_position - b.pick_position);
  const byPos = (pos: Position) => starting.filter((s) => s.position === pos);

  const base = starting.reduce((sum, p) => sum + (p.xp_next ?? 0), 0);
  const capXp = starting.find((s) => s.is_captain)?.xp_next ?? 0;
  const totalXp = base + capXp; // captain counts double

  const money = (v: number | null | undefined) => (v == null ? "—" : `£${(v / 10).toFixed(1)}m`);
  const stats = [
    { label: "Squad value", value: money(state.team_value) },
    { label: "In the bank", value: money(state.bank) },
    { label: nextGw != null ? `Proj. XI (GW${nextGw})` : "Proj. XI", value: `${totalXp.toFixed(1)} pts` },
    { label: "Chips left", value: String((state.chips_available ?? []).length) },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Team</h1>
        <p className="text-sm text-muted-foreground">
          Your live squad, each player showing projected xPts for the next gameweek. Captain counts double.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 text-lg font-semibold">{s.value}</div>
          </div>
        ))}
      </div>

      {(state.chips_available ?? []).length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Chips available:</span>
          {(state.chips_available as string[]).map((c) => (
            <span
              key={c}
              className="rounded-full border border-border/60 bg-muted px-2.5 py-0.5 text-xs font-medium"
            >
              {CHIP_LABEL[c] ?? c}
            </span>
          ))}
        </div>
      )}

      {state.gw === 0 && (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Preseason draft snapshot — the squad will auto-sync from public data once the GW1 deadline passes.
        </p>
      )}

      <div className="mt-6">
        <SquadPitch gk={byPos("GK")} def={byPos("DEF")} mid={byPos("MID")} fwd={byPos("FWD")} bench={bench} />
      </div>
    </main>
  );
}
