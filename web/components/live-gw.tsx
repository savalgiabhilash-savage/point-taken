"use client";

import * as React from "react";
import type { LiveData, LiveLeague } from "@/lib/live";
import { X, RefreshCw } from "lucide-react";

const STATE: Record<string, string> = { done: "FT", playing: "live", todo: "to play", dnp: "didn't play", blank: "no game" };

type LiveState = { data: LiveData | null; err: string | null; reload: () => Promise<void>; loading: boolean };
const LiveCtx = React.createContext<LiveState | null>(null);

// Polls /api/live every 60 s while games are on and shares it with the panel and the pitch cards.
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = React.useState<LiveData | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = React.useRef(true);

  // One fetch; schedules the next in 60 s unless every game is finished. Calling it again (pull-to-refresh,
  // the refresh button) restarts the 60 s clock.
  const reload = React.useCallback(async function run(): Promise<void> {
    clearTimeout(timer.current);
    setLoading(true);
    let final = false;
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      const j = await res.json();
      if (!alive.current) return;
      if (!res.ok) setErr(j.error ?? "Live data unavailable.");
      else { setData(j); setErr(null); final = j.status === "final"; }
    } catch {
      if (alive.current) setErr("Live data unavailable.");
    }
    if (!alive.current) return;
    setLoading(false);
    if (!final) timer.current = setTimeout(run, 60_000);
  }, []);

  React.useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, [reload]);

  return <LiveCtx.Provider value={{ data, err, reload, loading }}>{children}</LiveCtx.Provider>;
}

export function useLiveReload() {
  return React.useContext(LiveCtx)?.reload;
}

const STATE_SHORT: Record<string, string> = { done: "FT", playing: "live", todo: "to play", dnp: "DNP", blank: "no game" };

// Live points line on a pitch card: only inside LiveProvider (My Team), only for the GW whose squad the pitch shows.
export function LiveBadge({ playerId, gw }: { playerId: number; gw: number }) {
  const ctx = React.useContext(LiveCtx);
  const p = ctx?.data?.gw === gw ? ctx.data.players.find((x) => x.id === playerId) : undefined;
  if (!p || p.state === "todo" || p.state === "blank") return null;
  const pts = p.live * Math.max(p.mult, 1);
  return (
    <span
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${p.mult === 0 ? "bg-zinc-200 text-zinc-500" : "bg-zinc-900 text-white"}`}
      title={`GW${gw} live: ${pts} pts (${STATE[p.state]}${p.mult > 1 ? `, ×${p.mult}` : ""})`}
    >
      {p.state === "playing" && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />}
      GW{gw} {pts} · {STATE_SHORT[p.state]}
    </span>
  );
}

// Live GW panel (reads LiveProvider).
export function LiveGw() {
  const ctx = React.useContext(LiveCtx);
  const data = ctx?.data ?? null;
  const err = ctx?.err ?? null;
  const [openId, setOpenId] = React.useState<number | null>(null);

  if (err && !data) return <p className="mt-6 text-xs text-muted-foreground">• {err}</p>;
  if (!data) return <p className="mt-6 text-xs text-muted-foreground">• Loading live points…</p>;

  const label = data.status === "final" ? "Final" : data.status === "live" ? "Live" : "Not started";
  const stats = [
    { label: `GW${data.gw} points`, value: `${data.live}${data.hits ? ` (−${data.hits})` : ""}` },
    { label: `Projected GW${data.gw}`, value: `${(data.projected - data.hits).toFixed(1)}` },
    { label: "Season total", value: String(data.liveTotal) },
    { label: "Projected total", value: data.projectedTotal.toFixed(1) },
  ];
  const xi = data.players.filter((p) => p.mult > 0 || p.subbedOut);
  const bench = data.players.filter((p) => !(p.mult > 0 || p.subbedOut));
  const leagues = [...data.leagues].sort((a, b) => Number(a.projRank == null) - Number(b.projRank == null));

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-xl">
          GW{data.gw}
          {/* Broadcast-style status tag: red LIVE with a pulsing dot while games are on. */}
          <span
            className={`inline-flex -skew-x-12 items-center gap-1.5 px-2 py-0.5 text-[12px] tracking-[0.14em] ${
              data.status === "live" ? "bg-red-600 text-white" : "bg-muted text-muted-foreground"
            }`}
          >
            <span className="inline-flex skew-x-12 items-center gap-1.5">
              {data.status === "live" && <span className="live-dot size-1.5 rounded-full bg-white" />}
              {label}
            </span>
          </span>
        </h2>
        <button
          type="button"
          onClick={() => ctx?.reload()}
          disabled={ctx?.loading}
          className="-mr-2 flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          aria-label="Refresh live points"
        >
          Updated {new Date(data.updatedAt).toLocaleTimeString()}
          <RefreshCw className={`size-3.5 ${ctx?.loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-background/60 px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-0.5 font-display text-3xl tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      {data.notes.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-sm">{data.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[440px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Player</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 pr-3 text-right font-medium">Mins</th>
              <th className="py-1.5 pr-3 text-right font-medium">Pts</th>
              <th className="py-1.5 text-right font-medium">Proj.</th>
            </tr>
          </thead>
          <tbody>
            {[...xi, ...bench].map((p, i) => (
              <tr key={p.id} className={`border-t border-border/40 ${i === xi.length ? "border-t-2" : ""} ${p.mult === 0 ? "text-muted-foreground" : ""}`}>
                <td className="py-1.5 pr-3">
                  {p.name} <span className="text-xs text-muted-foreground">{p.team} · {p.pos}</span>
                  {p.mult > 1 && <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-500">{p.mult === 3 ? "TC" : "C"}</span>}
                  {p.subbedIn && <span className="ml-1.5 text-xs text-emerald-500">sub on</span>}
                  {p.subbedOut && <span className="ml-1.5 text-xs text-amber-500">subbed off</span>}
                </td>
                <td className="py-1.5 pr-3 text-xs">{STATE[p.state]}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{p.minutes}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{p.live * Math.max(p.mult, 1)}</td>
                <td className="py-1.5 text-right tabular-nums">{(p.proj * Math.max(p.mult, 1)).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {leagues.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Leagues</h3>
          {/* Grid, not a wide table: fits a phone without sideways scrolling. */}
          <div className="mt-1 grid grid-cols-[1fr_auto_auto] items-center gap-x-4 text-sm">
            <div className="py-1.5 text-xs uppercase tracking-wide text-muted-foreground">League</div>
            <div className="py-1.5 text-right text-xs uppercase tracking-wide text-muted-foreground">GW{data.gw}<div className="normal-case tracking-normal">live → proj.</div></div>
            <div className="py-1.5 text-right text-xs uppercase tracking-wide text-muted-foreground">Overall<div className="normal-case tracking-normal">live → proj.</div></div>
            {leagues.map((l) => (
              <React.Fragment key={l.id}>
                <div className="min-w-0 border-t border-border/40 py-1.5">
                  {l.table ? (
                    <button type="button" onClick={() => setOpenId(l.id)} className="min-h-11 text-left">
                      <span className="text-emerald-400 underline-offset-2 hover:underline">{l.name}</span>{" "}
                      <span className="text-xs text-muted-foreground">{l.members?.toLocaleString()} ›</span>
                      {l.estimated && (
                        <span className="block text-xs text-muted-foreground">Est. from the {l.table.length} managers around you</span>
                      )}
                      {l.leaderGap != null && (
                        <span className="block text-xs text-muted-foreground">
                          {l.leaderGap >= 0 ? `Projected lead +${l.leaderGap.toFixed(1)}` : `Projected ${Math.abs(l.leaderGap).toFixed(1)} behind leader`}
                        </span>
                      )}
                    </button>
                  ) : (
                    <div className="py-1">{l.name} <span className="text-xs text-muted-foreground">{l.members?.toLocaleString()}</span></div>
                  )}
                </div>
                <div className="self-stretch border-t border-border/40 py-1.5 text-right tabular-nums flex items-center justify-end">
                  {l.gwProjRank != null ? <Ranks live={l.gwLiveRank} proj={l.gwProjRank} /> : <span className="text-muted-foreground">{l.fplGwRank?.toLocaleString() ?? "—"}</span>}
                </div>
                <div className="self-stretch border-t border-border/40 py-1.5 text-right tabular-nums flex items-center justify-end">
                  {l.projRank != null ? (
                    <span className="inline-flex items-center gap-1">
                      {l.estimated && <span className="text-[10px] uppercase text-muted-foreground">est.</span>}
                      <Ranks live={l.liveRank} proj={l.projRank} />
                    </span>
                  ) : <span className="text-muted-foreground">{l.fplRank?.toLocaleString() ?? "—"}</span>}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
        <li>• Points from FPL&apos;s live feed, provisional bonus included; refreshes every minute while games are on</li>
        <li>• Projected = points so far + the pre-deadline projection for minutes still to play</li>
        <li>• Auto-subs and vice-captain applied once a player&apos;s games finish with 0 minutes</li>
        <li>• Leagues of up to 50 managers are projected from every rival&apos;s live team; tap one to see every team</li>
        <li>• GW rank = this gameweek&apos;s points only; overall = season total; bigger leagues show FPL&apos;s own rank (grey)</li>
      </ul>
      <LeagueDialog league={data.leagues.find((l) => l.id === openId) ?? null} gw={data.gw} onClose={() => setOpenId(null)} />
    </section>
  );
}

function Ranks({ live, proj }: { live: number | null; proj: number | null }) {
  const arrow = live != null && proj != null && proj !== live ? (proj < live ? "text-emerald-400" : "text-rose-400") : "";
  return (
    <span className="whitespace-nowrap">
      {live ?? "—"} → <b className={arrow}>{proj ?? "—"}</b>
    </span>
  );
}

// Every team in a projected league: GW and season points, live and projected.
function LeagueDialog({ league, gw, onClose }: { league: LiveLeague | null; gw: number; onClose: () => void }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (league && !d.open) d.showModal();
    if (!league && d.open) d.close();
  }, [league]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto max-h-[85dvh] w-[min(680px,calc(100vw-1.5rem))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/60"
    >
      {league?.table && (
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">{league.name}</h3>
              <p className="text-xs text-muted-foreground">
                {league.estimated
                  ? `• The ${league.table?.length ?? 0} managers around your rank, sorted by projected season total; ranks are estimates · GW${gw} points net of hits`
                  : `• Sorted by projected season total · GW${gw} points net of hits`}
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
              <X className="size-5" />
            </button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">#</th>
                  <th className="py-1.5 pr-3 font-medium">Team</th>
                  <th className="py-1.5 pr-3 text-right font-medium">GW{gw}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">GW{gw}<br />proj.</th>
                  <th className="hidden py-1.5 pr-3 text-right font-medium sm:table-cell">Total</th>
                  <th className="py-1.5 text-right font-medium">Total<br />proj.</th>
                </tr>
              </thead>
              <tbody>
                {league.table.map((r, i) => (
                  <tr key={r.entry} className={`border-t border-border/40 ${r.me ? "bg-emerald-500/10" : ""}`}>
                    <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{(league.offset ?? 0) + i + 1}</td>
                    <td className="py-1.5 pr-3">
                      <div className="font-medium">{r.team}{r.me && <span className="ml-1.5 text-xs text-emerald-400">you</span>}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.manager} · C {r.captain}
                        {r.chip && <span className="ml-1.5 rounded bg-muted px-1 text-[11px] text-foreground">{r.chip}</span>}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.gwLive}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.gwProj.toFixed(1)}</td>
                    <td className="hidden py-1.5 pr-3 text-right tabular-nums sm:table-cell">{r.totalLive}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{r.totalProj.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </dialog>
  );
}
