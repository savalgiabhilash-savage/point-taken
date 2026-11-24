"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ExternalLink, AlertTriangle } from "lucide-react";
import type { ThisWeek } from "@/lib/this-week";

// "This week" checklist: what to set in FPL before the deadline. Ticks are saved on this device per GW.

function countdown(deadline: string, now: number): string {
  const ms = Date.parse(deadline) - now;
  if (ms <= 0) return "deadline passed";
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export function ThisWeekCard({ w }: { w: ThisWeek }) {
  const key = `this-week-${w.gw}`;
  const [done, setDone] = React.useState<Record<string, boolean>>({});
  const [now, setNow] = React.useState<number | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      try { setDone(JSON.parse(localStorage.getItem(key) ?? "{}")); } catch {}
      setNow(Date.now());
    }, 0);
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [key]);

  const toggle = (id: string) =>
    setDone((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });

  const items: { id: string; title: string; detail: React.ReactNode }[] = [
    {
      id: "transfers",
      title: w.swaps.length ? `Make ${w.swaps.length} transfer${w.swaps.length > 1 ? "s" : ""}` : "No transfer: roll it",
      detail: w.swaps.length ? (
        <ul className="space-y-0.5">
          {w.swaps.map((s) => <li key={s.out}>• {s.out} → <b>{s.in ?? "—"}</b></li>)}
          <li className="text-muted-foreground">• {w.hits > 0 ? `Costs a −${w.hits * 4} pt hit` : "Within your free transfers"}{w.net != null ? ` · net ${w.net >= 0 ? "+" : ""}${w.net.toFixed(1)} pts over the plan` : ""}</li>
        </ul>
      ) : (
        <>• Keep your free transfer{w.freeAfter != null ? `: ${w.freeAfter} available next GW` : ""}</>
      ),
    },
    {
      id: "captain",
      title: w.captain ? `Captain ${w.captain}` : "Captain",
      detail: <>• Vice-captain {w.vice ?? "—"}</>,
    },
    {
      id: "chip",
      title: w.chip ? `Play ${w.chip.name}` : "No chip this week",
      detail: w.chip ? (
        <>• +{w.chip.gain.toFixed(1)} projected pts; this is its planned week</>
      ) : w.chipNext ? (
        <>• Save your chips; next planned: {w.chipNext.name} in GW{w.chipNext.gw}</>
      ) : (
        <>• Save your chips; no week clears the bar yet</>
      ),
    },
    {
      id: "bench",
      title: "Set the bench order",
      detail: <>• {w.bench.map((b, i) => `${i + 1}. ${b}`).join(" · ") || "—"}</>,
    },
  ];
  const ticked = items.filter((i) => done[i.id]).length;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <span className="inline-block -skew-x-12 bg-grad px-2 py-0.5">
            <span className="inline-block skew-x-12 text-[11px] font-bold uppercase tracking-[0.16em]">This week</span>
          </span>
          <h2 className="mt-1 font-display text-xl">GW{w.gw} checklist</h2>
        </div>
        <div className="text-right text-sm">
          {w.deadline && (
            <div>
              Deadline {new Date(w.deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              {now != null && <span className="ml-1 font-semibold text-brand">{countdown(w.deadline, now)}</span>}
            </div>
          )}
          <div className="text-xs text-muted-foreground">{ticked} of {items.length} done</div>
        </div>
      </div>

      {w.stale && (
        <p className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-sm text-amber-400">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          Your squad changed since this plan; <Link href="/optimizer" className="underline">re-optimize</Link> before following it
        </p>
      )}

      <ul className="divide-y divide-border">
        {items.map((it) => (
          <li key={it.id} className="flex gap-3 px-4 py-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={!!done[it.id]}
              aria-label={`Mark "${it.title}" done`}
              onClick={() => toggle(it.id)}
              className={`relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition before:absolute before:-inset-3 ${
                done[it.id] ? "border-transparent bg-grad glow" : "border-border hover:border-brand/60"
              }`}
            >
              {done[it.id] && <Check className="size-4" aria-hidden />}
            </button>
            <div className={`min-w-0 text-sm ${done[it.id] ? "opacity-60" : ""}`}>
              <div className={`font-semibold ${done[it.id] ? "line-through" : ""}`}>{it.title}</div>
              <div className="mt-0.5 text-muted-foreground [&_b]:text-foreground">{it.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        <a href="https://fantasy.premierleague.com/transfers" target="_blank" rel="noopener noreferrer" className="press inline-flex h-9 items-center gap-1.5 rounded-md bg-grad px-3 text-sm font-bold uppercase tracking-wide glow">
          Transfers in FPL <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <a href="https://fantasy.premierleague.com/my-team" target="_blank" rel="noopener noreferrer" className="press inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold">
          Pick team in FPL <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <Link href="/optimizer" className="press inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground hover:text-foreground">Full plan</Link>
      </div>
    </section>
  );
}
