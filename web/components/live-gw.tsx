"use client";

import * as React from "react";
import type { LiveData } from "@/lib/live";

const STATE: Record<string, string> = { done: "FT", playing: "live", todo: "to play", dnp: "didn't play", blank: "no game" };

type LiveState = { data: LiveData | null; err: string | null };
const LiveCtx = React.createContext<LiveState | null>(null);

// Polls /api/live every 60 s while games are on and shares it with the panel and the pitch cards.
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = React.useState<LiveData | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const j = await res.json();
        if (stop) return;
        if (!res.ok) setErr(j.error ?? "Live data unavailable.");
        else { setData(j); setErr(null); if (j.status === "final") return; }
      } catch {
        if (!stop) setErr("Live data unavailable.");
      }
      if (!stop) timer = setTimeout(load, 60_000);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, []);

  return <LiveCtx.Provider value={{ data, err }}>{children}</LiveCtx.Provider>;
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
    <section className="mt-6 rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">
          GW{data.gw} · {label}
          {data.status === "live" && <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        </h2>
        <span className="text-xs text-muted-foreground">Updated {new Date(data.updatedAt).toLocaleTimeString()}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{s.value}</div>
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
        <div className="mt-5 overflow-x-auto">
          <h3 className="text-sm font-semibold">Leagues</h3>
          <table className="mt-1 w-full min-w-[440px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">League</th>
                <th className="py-1.5 pr-3 text-right font-medium">Live rank</th>
                <th className="py-1.5 pr-3 text-right font-medium">Projected rank</th>
                <th className="py-1.5 text-right font-medium">vs leader (proj.)</th>
              </tr>
            </thead>
            <tbody>
              {leagues.map((l) => (
                <tr key={l.id} className="border-t border-border/40">
                  <td className="py-1.5 pr-3">{l.name} <span className="text-xs text-muted-foreground">{l.members?.toLocaleString()}</span></td>
                  {l.projRank != null ? (
                    <>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{l.liveRank}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{l.projRank}</td>
                      <td className="py-1.5 text-right tabular-nums">{l.leaderGap == null ? "—" : `${l.leaderGap >= 0 ? "+" : ""}${l.leaderGap.toFixed(1)}`}</td>
                    </>
                  ) : (
                    <>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{l.fplRank?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right text-xs text-muted-foreground">too big</td>
                      <td className="py-1.5 text-right text-muted-foreground">—</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
        <li>• Points from FPL&apos;s live feed, provisional bonus included; refreshes every minute while games are on</li>
        <li>• Projected = points so far + the pre-deadline projection for minutes still to play</li>
        <li>• Auto-subs and vice-captain applied once a player&apos;s games finish with 0 minutes</li>
        <li>• Leagues of up to 50 managers are projected from every rival&apos;s live team; bigger leagues show FPL&apos;s last rank</li>
      </ul>
    </section>
  );
}
