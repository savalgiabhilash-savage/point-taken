import { type Position } from "@/lib/supabase";
import { createServerSupabase } from "@/lib/supabase/server";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";
import { OptimizeControls } from "@/components/optimize-controls";

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

type PathStep = {
  gw: number;
  in: Move[];
  out: Move[];
  num: number;
  hits: number;
  free: number;
  xi: number;
};

type Chip = {
  chip: string;
  gw: number;
  gain: number;
  detail: string;
  available: boolean;
  threshold?: number;
  gw_type?: string; // "DGW" | "BGW" | "" — set once the season's doubles/blanks are announced
};

type Transfers = {
  out: Move[];
  in: Move[];
  num: number;
  free_transfers: number | null;
  hits: number;
  hit_cost: number;
  path?: PathStep[];
  chips?: Chip[];
  chip_reco?: string;
  planned_pts?: number;
  hold_pts?: number;
  based_on?: number[]; // the squad (element ids) this plan was computed against
};

const POS_ACCENT: Record<Position, string> = {
  GK: "text-amber-400",
  DEF: "text-emerald-400",
  MID: "text-sky-400",
  FWD: "text-rose-400",
};

const CHIP_STYLE: Record<string, string> = {
  "Triple Captain": "text-violet-400",
  "Bench Boost": "text-amber-400",
  Wildcard: "text-emerald-400",
  "Free Hit": "text-sky-400",
};

// FPL transfers are like-for-like by position (a DEF out ⇒ a DEF in — the squad keeps 2/5/5/3),
// so pair each OUT with an IN of the SAME position rather than by list order.
function pairByPosition(out: Move[], inn: Move[]): [Move, Move | undefined][] {
  const queues = new Map<Position, Move[]>();
  for (const p of inn) {
    const q = queues.get(p.position) ?? [];
    q.push(p);
    queues.set(p.position, q);
  }
  return out.map((o) => [o, queues.get(o.position)?.shift()]);
}

function MovePill({ p, dir }: { p: Move; dir: "out" | "in" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
        dir === "out"
          ? "bg-rose-500/10 text-rose-300"
          : "bg-emerald-500/10 text-emerald-300"
      }`}
    >
      <span className={`text-[9px] font-bold ${POS_ACCENT[p.position]}`}>{p.position}</span>
      {p.web_name}
    </span>
  );
}

export default async function OptimizerPage() {
  const supabase = await createServerSupabase();
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData.user?.id ?? "me";
  const { data: runs } = await supabase
    .from("optimizer_runs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  const run = runs?.[0];

  // How many upcoming gameweeks we have projections for = the max plan horizon the user can pick.
  // Shrinks as the season progresses ("gameweeks left").
  const [{ data: gwMax }, { data: gwMin }] = await Promise.all([
    supabase.from("projections").select("gw").eq("model_version", "rules-v1").order("gw", { ascending: false }).limit(1),
    supabase.from("projections").select("gw").eq("model_version", "rules-v1").order("gw", { ascending: true }).limit(1),
  ]);
  const maxGw = (gwMax?.[0]?.gw as number | undefined) ?? null;
  const minGw = (gwMin?.[0]?.gw as number | undefined) ?? null;
  const maxHorizon = maxGw != null && minGw != null ? Math.max(1, Math.min(maxGw - minGw + 1, 38)) : 5;

  if (!run) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Optimizer</h1>
        {userId !== "me" ? (
          <>
            <p className="mt-4 text-sm text-muted-foreground">
              No plan yet. Pick a horizon and optimize your current squad — it runs in the cloud and
              appears here in a minute or two.
            </p>
            <OptimizeControls initialHorizon={5} maxHorizon={maxHorizon} userId={userId} lastComputedAt={null} />
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No optimization yet. Run <code>python -m fpl_worker.optimize --plan</code>.
          </p>
        )}
      </main>
    );
  }

  const squad = (run.suggested_squad ?? []) as OptPlayer[];
  const transfers = (run.transfers ?? null) as Transfers | null;

  // Staleness: the optimizer runs on a schedule (and after a team change), NOT live on this page.
  // Compare the user's current squad to the one the plan was computed against; if they differ, the
  // plan predates the change and we warn rather than show stale transfers.
  const { data: teamRows } = await supabase
    .from("user_team_state")
    .select("picks")
    .eq("user_id", userId)
    .order("gw", { ascending: false })
    .limit(1);
  const currentIds = ((teamRows?.[0]?.picks ?? []) as { element: number }[])
    .map((p) => p.element)
    .sort((a, b) => a - b);
  const basedOn = (transfers?.based_on ?? []).slice().sort((a, b) => a - b);
  const stale =
    basedOn.length > 0 &&
    currentIds.length > 0 &&
    (currentIds.length !== basedOn.length || currentIds.some((id, i) => id !== basedOn[i]));
  const horizon = (run.horizon as number | null) ?? 5;
  const chipReco = (run.chip_reco as string | null) ?? transfers?.chip_reco ?? null;
  const path = transfers?.path ?? null;
  const chips = transfers?.chips ?? null;
  // Highlight only a chip actually worth playing (gain clears its own bar); otherwise nothing —
  // the banner says "hold". Never highlight the mere max-gain chip when the call is to hold.
  const recommended =
    chips
      ?.filter((c) => c.available && c.threshold != null && c.gain >= c.threshold)
      .reduce<Chip | null>(
        (b, c) => (c.gain - c.threshold! > (b ? b.gain - b.threshold! : -1e9) ? c : b),
        null,
      ) ?? null;

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
    xp_horizon: p.xp5,
    note: p.is_captain
      ? "Captain — the highest projected returns in your XI, so the ×2 goes here."
      : p.is_start
        ? "Starts: highest projected points for its slot within the squad rules."
        : "Bench: covers a starter; projected below the XI but keeps a legal 15.",
  });

  const starters = squad.filter((p) => p.is_start);
  const bench = squad.filter((p) => !p.is_start);
  const byPos = (pos: Position) => starters.filter((p) => p.position === pos).map(toSP);
  const cost = squad.reduce((s, p) => s + p.now_cost, 0) / 10;
  const captain = squad.find((p) => p.is_captain);
  const gain = run.expected_gain as number | null;

  const thisWeek = path?.[0] ?? null;
  const thisWeekHit =
    thisWeek == null
      ? null
      : thisWeek.hits > 0
        ? `−${thisWeek.hits * 4} pt hit`
        : "within free transfers";

  const stats = [
    { label: "Squad cost", value: `£${cost.toFixed(1)}m` },
    {
      label: `Planned (${horizon} GW)`,
      value: transfers?.planned_pts != null ? `${transfers.planned_pts.toFixed(0)} pts` : "—",
      sub: transfers?.hold_pts != null ? `vs ${transfers.hold_pts.toFixed(0)} holding` : undefined,
    },
    { label: "Captain (GW)", value: captain?.web_name ?? "—" },
    {
      label: "This week",
      value: thisWeek ? `${thisWeek.num} transfer${thisWeek.num === 1 ? "" : "s"}` : "—",
      sub: thisWeekHit ?? undefined,
    },
  ];

  // Plain-English rationale for the plan, built from the run itself (no LLM — every line traces to a
  // number the model produced), so the "why" is transparent.
  const rationale: string[] = [
    `Planning over the next ${horizon} gameweek${horizon === 1 ? "" : "s"} — nearer gameweeks count for more (later ones are discounted as less certain).`,
  ];
  if (captain) {
    rationale.push(
      `Captain ${captain.web_name}: ${captain.xpn.toFixed(1)} projected pts next GW — the highest in your XI, so the ×2 goes to them.`,
    );
  }
  if (thisWeek && thisWeek.num > 0) {
    rationale.push(
      thisWeek.hits > 0
        ? `${thisWeek.num} transfer${thisWeek.num === 1 ? "" : "s"} this week including a −${thisWeek.hits * 4} hit — taken only because the incoming players add more than the 4-point cost.`
        : `${thisWeek.num} transfer${thisWeek.num === 1 ? "" : "s"} this week, all within your free transfers — each swaps in a higher-projected player at the same position.`,
    );
  } else if (thisWeek) {
    rationale.push(`No transfer this week — your squad is already best for now, so roll the free transfer for later.`);
  }
  if (gain != null) {
    rationale.push(
      `Net effect: ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} xPts versus simply holding your current squad across the horizon.`,
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Optimizer</h1>
        <p className="text-sm text-muted-foreground">
          A multi-week plan for your squad over the next {horizon} gameweeks: a transfer path (which week to move,
          when to roll a free transfer, when a −4 hit pays off) plus chip timing. Respects £100m, 2/5/5/3,
          ≤3 per club, valid formation, and free-transfer rollover (HiGHS MILP).
        </p>
      </div>

      {userId !== "me" && (
        <OptimizeControls
          initialHorizon={horizon}
          maxHorizon={maxHorizon}
          userId={userId}
          lastComputedAt={(run.created_at as string | null) ?? null}
        />
      )}

      {stale && (
        <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-amber-400">Plan out of date</span>
          <div className="mt-0.5 text-sm text-amber-700 dark:text-amber-300">
            Your squad changed since this plan was computed, so the transfers below still reference your
            previous team. A fresh optimization runs automatically after a team change (usually within a
            minute or two) and on the 3-hourly sync — reload this page then.
          </div>
        </div>
      )}

      {gain != null && (
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <span className="text-lg font-semibold text-emerald-400">
            {gain >= 0 ? "+" : ""}
            {gain.toFixed(1)} xPts
          </span>{" "}
          <span className="text-sm text-muted-foreground">
            projected over the next {horizon} GWs vs simply holding your current squad (net of any hits).
          </span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-1 truncate text-lg font-semibold">{s.value}</div>
            {s.sub ? <div className="text-xs text-muted-foreground">{s.sub}</div> : null}
          </div>
        ))}
      </div>

      {chipReco && (
        <div className="mt-5 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-violet-300">Chip timing</span>
          <div className="mt-0.5 text-sm">{chipReco}</div>
        </div>
      )}

      <div className="mt-5 rounded-xl border border-border/60 bg-card px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why this plan</span>
        <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
          {rationale.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-0.5 text-emerald-400">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        {/* Transfer path */}
        <section>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Transfer path
          </div>
          {path && path.length > 0 ? (
            <ol className="space-y-2">
              {path.map((step) => (
                <li
                  key={step.gw}
                  className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-card px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">GW{step.gw}</span>
                    <span className="text-xs text-muted-foreground">
                      {step.num === 0
                        ? `roll · ${step.free} FT banked`
                        : `${step.num} transfer${step.num === 1 ? "" : "s"}${
                            step.hits > 0 ? ` · −${step.hits * 4}` : ""
                          }`}
                    </span>
                  </div>
                  {step.num > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {pairByPosition(step.out, step.in).map(([o, inp]) => (
                        <span key={o.fpl_id} className="flex items-center gap-1.5">
                          <MovePill p={o} dir="out" />
                          <span className="text-muted-foreground">→</span>
                          {inp ? <MovePill p={inp} dir="in" /> : null}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No transfer path (run --plan).</p>
          )}
        </section>

        {/* Chip timing */}
        <section>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Chip windows
          </div>
          {chips && chips.length > 0 ? (
            <ul className="space-y-2">
              {chips.map((c) => {
                const isBest = recommended != null && c.chip === recommended.chip;
                return (
                  <li
                    key={c.chip}
                    className={`rounded-lg border px-3 py-2 ${
                      isBest ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/50 bg-card"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-semibold ${CHIP_STYLE[c.chip] ?? ""}`}>
                        {c.chip}
                        {!c.available ? (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">used</span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                        {c.gw_type === "DGW" || c.gw_type === "BGW" ? (
                          <span
                            className={`rounded px-1 py-0.5 text-[9px] font-bold tracking-wide ${
                              c.gw_type === "DGW"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-amber-500/15 text-amber-300"
                            }`}
                            title={c.gw_type === "DGW" ? "Double Gameweek" : "Blank Gameweek"}
                          >
                            {c.gw_type}
                          </span>
                        ) : null}
                        <span>
                          GW{c.gw} · <span className="text-foreground">+{c.gain.toFixed(1)}</span>
                        </span>
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{c.detail}</div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No chip analysis (run --plan).</p>
          )}
        </section>
      </div>

      <div className="mt-8">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          This week&apos;s squad (GW{thisWeek?.gw ?? run.gw})
        </div>
        <SquadPitch gk={byPos("GK")} def={byPos("DEF")} mid={byPos("MID")} fwd={byPos("FWD")} bench={bench.map(toSP)} />
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Projections span the next {horizon} GWs. Chip gains are largest in Double/Blank gameweeks, which are
        announced in-season — until then Wildcard and Triple Captain tend to dominate. See the Guide for details.
      </p>
    </main>
  );
}
