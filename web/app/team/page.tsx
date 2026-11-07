import { MODEL_VERSION, type Position } from "@/lib/supabase";
import { createServerSupabase } from "@/lib/supabase/server";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";
import { TeamUpload } from "@/components/team-upload";
import { LiveGw, LiveProvider } from "@/components/live-gw";
import { opponentLabels } from "@/lib/fixtures";
import type { OutcomeRange } from "@/lib/insight";
import Link from "next/link";

export const dynamic = "force-dynamic";

const MODEL = MODEL_VERSION;
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

type CheckPlayer = { fpl_id: number; web_name: string; position: Position | null; xp_next: number | null };

// Best legal XI (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD) from the 15 by projected points, as worker optimize._best_xi.
function bestXi<T extends CheckPlayer>(squad: T[]): T[] {
  const by = (pos: Position) =>
    squad.filter((p) => p.position === pos).sort((a, b) => (b.xp_next ?? 0) - (a.xp_next ?? 0));
  const [gk, def, mid, fwd] = [by("GK"), by("DEF"), by("MID"), by("FWD")];
  let best: T[] = [];
  let bestVal = -Infinity;
  for (let d = 3; d <= 5; d++)
    for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f < 1 || f > 3 || def.length < d || mid.length < m || fwd.length < f || !gk.length) continue;
      const xi = [gk[0], ...def.slice(0, d), ...mid.slice(0, m), ...fwd.slice(0, f)];
      const val = xi.reduce((s, p) => s + (p.xp_next ?? 0), 0);
      if (val > bestVal) [best, bestVal] = [xi, val];
    }
  return best;
}

export default async function TeamPage() {
  const supabase = await createServerSupabase();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">My Team</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          <Link href="/login" className="text-emerald-400 hover:underline">Log in</Link> and connect your FPL team in Settings to see your squad here.
        </p>
      </main>
    );
  }
  const userId = authData.user.id;

  const { data: stateRows } = await supabase
    .from("user_team_state")
    .select("*")
    .eq("user_id", userId)
    .order("gw", { ascending: false })
    .limit(1);
  const state = stateRows?.[0];
  const picks = (state?.picks ?? []) as Pick[];

  if (!state || picks.length === 0) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">My Team</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          No squad synced for your account yet. Add your FPL entry ID and sync in{" "}
          <Link href="/settings" className="text-emerald-400 hover:underline">Settings</Link>{" "}
          (your squad becomes available once GW1&apos;s deadline passes).
        </p>
        <div className="mt-6 max-w-md">
          <TeamUpload
            title="Upload a team screenshot"
            note="Preseason your squad is private on the FPL API. Screenshot your team from the FPL app or site (all 15 — 11 starters + 4 bench, with the C/V armbands) and upload it to load them here now. Your actual team replaces this automatically once the GW deadline passes and it syncs from FPL."
          />
        </div>
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
      .select("player_id, gw, x_pts, components")
      .eq("model_version", MODEL)
      .in("player_id", els),
  ]);

  const projs = projRes.data ?? [];
  const nextGw = projs.length ? Math.min(...projs.map((p) => p.gw)) : null;
  const opponents = nextGw != null ? ((await opponentLabels(supabase, [nextGw]))[nextGw] ?? {}) : undefined;
  const xpByPlayer = new Map<number, number>();
  const rangeByPlayer = new Map<number, OutcomeRange>();
  for (const r of projs) {
    if (r.gw !== nextGw) continue;
    xpByPlayer.set(r.player_id, r.x_pts ?? 0);
    const range = (r.components as { range?: OutcomeRange } | null)?.range;
    if (range) rangeByPlayer.set(r.player_id, range);
  }
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

  // Deadline check: your current XI and captain vs the best of the same 15 on the latest projections.
  const best = bestXi(squad);
  const bestIds = new Set(best.map((p) => p.fpl_id));
  const startIn = best.filter((p) => !starting.some((s) => s.fpl_id === p.fpl_id));
  const benchOut = starting.filter((p) => !bestIds.has(p.fpl_id)).sort((a, b) => (a.xp_next ?? 0) - (b.xp_next ?? 0));
  const bestCap = [...best].sort((a, b) => (b.xp_next ?? 0) - (a.xp_next ?? 0))[0];
  const curCap = starting.find((s) => s.is_captain);
  // Pair each swap with a dropped starter of the same position where possible (GK for GK), else the weakest left.
  const pool = [...benchOut];
  const checks: string[] = startIn.map((p) => {
    const k = pool.findIndex((o) => o.position === p.position);
    const o = pool.splice(k >= 0 ? k : 0, 1)[0];
    const gain = (p.xp_next ?? 0) - (o?.xp_next ?? 0);
    return `Start ${p.web_name} (${(p.xp_next ?? 0).toFixed(1)}) instead of ${o?.web_name ?? "?"} (${(o?.xp_next ?? 0).toFixed(1)}): +${gain.toFixed(1)} pts`;
  });
  if (bestCap && curCap && bestCap.fpl_id !== curCap.fpl_id && (bestCap.xp_next ?? 0) > (curCap.xp_next ?? 0))
    checks.push(
      `Captain ${bestCap.web_name} (${(bestCap.xp_next ?? 0).toFixed(1)}) instead of ${curCap.web_name} (${(curCap.xp_next ?? 0).toFixed(1)}): +${((bestCap.xp_next ?? 0) - (curCap.xp_next ?? 0)).toFixed(1)} pts`,
    );

  // Captain options: the five starters with the highest average, each with his simulated range.
  const capOptions = [...starting]
    .filter((s) => s.xp_next != null)
    .sort((a, b) => (b.xp_next ?? 0) - (a.xp_next ?? 0))
    .slice(0, 5);

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
    <LiveProvider>
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Team</h1>
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          <li>• Your squad with each player&apos;s projected points for the next gameweek</li>
          <li>• Captain counts double; tap the i on any player for the reasoning</li>
          <li>• Live GW: points so far, projected finish and your projected rank in each league</li>
        </ul>
      </div>

      {state.fpl_entry_id != null && <LiveGw />}

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

      {state.gw === 0 ? (
        <ul className="mt-4 space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <li>• Preseason draft snapshot</li>
          <li>• Replaced by your actual team once the GW deadline passes and it syncs from FPL</li>
        </ul>
      ) : state.fpl_entry_id == null ? (
        <ul className="mt-4 space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <li>• Uploaded squad for GW{state.gw}</li>
          <li>• Overrides your synced team until the GW{state.gw} deadline, then FPL&apos;s real picks replace it</li>
          <li>• Bank and free transfers are carried over from your last sync</li>
        </ul>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Live team · GW{state.gw} — synced from your FPL account.
        </p>
      )}

      <div className="mt-6">
        <SquadPitch gk={byPos("GK")} def={byPos("DEF")} mid={byPos("MID")} fwd={byPos("FWD")} bench={bench} opponents={opponents} liveGw={state.fpl_entry_id != null ? state.gw : undefined} />
      </div>

      {nextGw != null && best.length === 11 && (
        <section
          className={`mt-8 rounded-xl border p-4 shadow-sm ${checks.length ? "border-amber-500/40 bg-amber-500/10" : "border-border/60 bg-card"}`}
        >
          <h2 className="text-base font-semibold">Deadline check · GW{nextGw}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {checks.length ? (
              checks.map((c) => <li key={c}>• {c}</li>)
            ) : (
              <li>• Your XI and captain are already the best of your 15 on the latest projections</li>
            )}
          </ul>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <li>• Compares the line-up FPL shows for your last deadline with the latest projections (refreshed every 2 hours)</li>
            <li>• Transfers you&apos;ve made since aren&apos;t visible to the app until the deadline passes</li>
            <li>• Check again shortly before the deadline: late team news can change projections</li>
          </ul>
        </section>
      )}

      {capOptions.length > 0 && nextGw != null && (
        <section className="mt-8 rounded-xl border border-border/60 bg-card p-4 shadow-sm">
          <h2 className="text-base font-semibold">Captain options · GW{nextGw}</h2>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <li>• Ranked by average points: the pick that scores most over a season</li>
            <li>• Range = 8 weeks in 10 land inside it (simulated); points shown before the captain doubles them</li>
          </ul>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[460px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Player</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Avg</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Range</th>
                  <th className="py-1.5 pr-3 text-right font-medium">10+ pts</th>
                  <th className="py-1.5 text-right font-medium">≤ 2 pts</th>
                </tr>
              </thead>
              <tbody>
                {capOptions.map((p, i) => {
                  const r = rangeByPlayer.get(p.fpl_id);
                  return (
                    <tr key={p.fpl_id} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">
                        {p.web_name} <span className="text-xs text-muted-foreground">{p.team_short}</span>
                        {i === 0 && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-500">best</span>}
                        {p.is_captain && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">your C</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{(p.xp_next ?? 0).toFixed(1)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r ? `${r.p10}–${r.p90}` : "—"}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r ? `${Math.round(r.p_haul * 100)}%` : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{r ? `${Math.round(r.p_blank * 100)}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="mt-8 max-w-md border-t border-border/50 pt-6">
        <TeamUpload
          title="Replace with a screenshot"
          note={
            state.gw === 0
              ? "Uploaded the wrong team, or made changes? Upload a fresh screenshot to update this draft. After the GW deadline your actual team syncs from FPL and takes over automatically."
              : "Made transfers for the next deadline? FPL doesn't show them publicly until the deadline passes. Upload a screenshot of your updated team to plan with it now; FPL's real picks take over after the deadline."
          }
        />
      </div>
    </main>
    </LiveProvider>
  );
}
