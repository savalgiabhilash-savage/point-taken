import { createSupabaseServerClient, type Position } from "@/lib/supabase";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";

export const dynamic = "force-dynamic";

type OptPlayer = {
  fpl_id: number;
  web_name: string;
  position: Position;
  team_short: string;
  now_cost: number;
  xp5: number;
  xpn: number;
  is_start: boolean;
  is_captain: boolean;
};

type Move = {
  fpl_id: number;
  web_name: string;
  position: Position;
  team_short: string;
  now_cost: number;
  xp5: number;
};

type Transfers = {
  out: Move[];
  in: Move[];
  num: number;
  free_transfers: number | null;
  hits: number;
  hit_cost: number;
};

const POS_ACCENT: Record<Position, string> = {
  GK: "text-amber-400",
  DEF: "text-emerald-400",
  MID: "text-sky-400",
  FWD: "text-rose-400",
};

function MoveRow({ p }: { p: Move }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-bold ${POS_ACCENT[p.position]}`}>{p.position}</span>
        <span className="text-sm font-medium">{p.web_name}</span>
        <span className="text-xs text-muted-foreground">{p.team_short}</span>
      </div>
      <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
        <span>£{(p.now_cost / 10).toFixed(1)}</span>
        <span className="text-foreground">{p.xp5.toFixed(1)}</span>
      </div>
    </div>
  );
}

export default async function OptimizerPage() {
  const supabase = createSupabaseServerClient();
  const { data: runs } = await supabase
    .from("optimizer_runs")
    .select("*")
    .eq("user_id", "me")
    .order("created_at", { ascending: false })
    .limit(1);
  const run = runs?.[0];

  if (!run) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Optimizer</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          No optimization yet. Run <code>python -m fpl_worker.optimize --transfers</code>.
        </p>
      </main>
    );
  }

  const squad = (run.suggested_squad ?? []) as OptPlayer[];
  const transfers = (run.transfers ?? null) as Transfers | null;
  const toSP = (p: OptPlayer): SquadPlayer => ({
    fpl_id: p.fpl_id,
    web_name: p.web_name,
    position: p.position,
    team_short: p.team_short,
    now_cost: p.now_cost,
    status: "a",
    is_captain: p.is_captain,
    is_vice_captain: false,
    xp_next: p.xpn,
  });

  const starters = squad.filter((p) => p.is_start);
  const bench = squad.filter((p) => !p.is_start);
  const byPos = (pos: Position) => starters.filter((p) => p.position === pos).map(toSP);
  const cost = squad.reduce((s, p) => s + p.now_cost, 0) / 10;
  const xi5 = starters.reduce((s, p) => s + p.xp5, 0);
  const captain = squad.find((p) => p.is_captain);
  const gain = run.expected_gain as number | null;

  const hitLabel =
    transfers == null
      ? null
      : transfers.hit_cost > 0
        ? `−${transfers.hit_cost} pt hit`
        : transfers.free_transfers == null
          ? "free (unlimited preseason)"
          : "within free transfers";

  const stats = [
    { label: "Squad cost", value: `£${cost.toFixed(1)}m` },
    { label: "Proj. XI (5 GW)", value: `${xi5.toFixed(1)} pts` },
    { label: "Captain", value: captain?.web_name ?? "—" },
    {
      label: "Transfers",
      value: transfers ? `${transfers.num}` : "—",
      sub: transfers ? (hitLabel ?? undefined) : undefined,
    },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Optimizer</h1>
        <p className="text-sm text-muted-foreground">
          The best transfers from your current squad over the next 5 GWs — a move is only made when its
          projected gain beats the −4 hit. Respects £100m, 2/5/5/3, ≤3 per club, valid formation (HiGHS).
        </p>
      </div>

      {gain != null && (
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <span className="text-lg font-semibold text-emerald-400">
            {gain >= 0 ? "+" : ""}
            {gain.toFixed(1)} xPts
          </span>{" "}
          <span className="text-sm text-muted-foreground">
            projected over the next 5 GWs vs your current XI{transfers && transfers.hit_cost > 0 ? ", after hits" : ""}.
          </span>
        </div>
      )}

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

      {transfers && transfers.num > 0 && (
        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-rose-400">
              Transfer out ({transfers.out.length})
            </div>
            <div className="space-y-2">
              {transfers.out.map((p) => (
                <MoveRow key={p.fpl_id} p={p} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-400">
              Transfer in ({transfers.in.length})
            </div>
            <div className="space-y-2">
              {transfers.in.map((p) => (
                <MoveRow key={p.fpl_id} p={p} />
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="mt-8">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Resulting squad
        </div>
        <SquadPitch gk={byPos("GK")} def={byPos("DEF")} mid={byPos("MID")} fwd={byPos("FWD")} bench={bench.map(toSP)} />
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Single-deadline optimization valued over 5 GWs. Multi-week sequencing (rolling free transfers,
        planned hits) and chip timing are the next upgrade.
      </p>
    </main>
  );
}
