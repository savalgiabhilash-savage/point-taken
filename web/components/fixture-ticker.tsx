"use client";

import * as React from "react";
import Link from "next/link";
import type { TickerFixture, TickerTeam } from "@/lib/ticker";

// Fixture ticker (lib/ticker.ts has the maths). Every fixture in view is ranked against all the others and
// split into five equal bands, so the colours are relative: green = among the easiest on show.

type View = "overall" | "attack" | "defence";
const VIEWS: { key: View; label: string; blurb: string }[] = [
  { key: "overall", label: "Overall", blurb: "goals your team should score minus goals it should concede" },
  { key: "attack", label: "Attack", blurb: "goals your team should score: picks for forwards and midfielders" },
  { key: "defence", label: "Defence", blurb: "goals your team should concede: clean-sheet chances for GKs and defenders" },
];
const HORIZONS = [1, 3, 5, 8] as const;
const BANDS = [
  { label: "Very hard", cls: "bg-rose-500 text-rose-950" },
  { label: "Hard", cls: "bg-orange-400 text-orange-950" },
  { label: "Medium", cls: "bg-slate-500/70 text-slate-50" },
  { label: "Easy", cls: "bg-lime-300 text-lime-950" },
  { label: "Very easy", cls: "bg-emerald-500 text-emerald-950" },
];

const ease = (f: TickerFixture, v: View) => (v === "attack" ? f.gf : v === "defence" ? -f.ga : f.gf - f.ga);

export function FixtureTicker({ teams, gws, formGames, formWeight }: { teams: TickerTeam[]; gws: number[]; formGames: number; formWeight: number }) {
  const [view, setView] = React.useState<View>("overall");
  const [h, setH] = React.useState<number>(5);
  const [sel, setSel] = React.useState<{ team: TickerTeam; f: TickerFixture } | null>(null);
  const shown = gws.slice(0, Math.min(h, gws.length));

  // Percentile of every fixture in view (0 = hardest, 1 = easiest), then its band.
  const { pct, rows } = React.useMemo(() => {
    const all = teams.flatMap((t) => shown.flatMap((g) => t.byGw[g] ?? [])).map((f) => ease(f, view)).sort((a, b) => a - b);
    const pctOf = (e: number) => {
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (all[m] < e) lo = m + 1;
        else hi = m;
      }
      let eq = lo;
      while (eq < all.length && all[eq] === e) eq++;
      return all.length ? (lo + (eq - lo) / 2) / all.length : 0.5;
    };
    // Run ease: each GW scores the sum of its fixtures' percentiles (a double counts both, a blank 0), averaged.
    const rows = teams
      .map((t) => {
        const total = shown.reduce((s, g) => s + (t.byGw[g] ?? []).reduce((a, f) => a + pctOf(ease(f, view)), 0), 0);
        return { t, run: shown.length ? (total / shown.length) * 10 : 0 };
      })
      .sort((a, b) => b.run - a.run);
    return { pct: pctOf, rows };
  }, [teams, shown, view]);
  const band = (f: TickerFixture) => BANDS[Math.min(4, Math.floor(pct(ease(f, view)) * 5))];
  const v = VIEWS.find((x) => x.key === view)!;

  return (
    <div className="mt-5 space-y-4">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">View</span>
          <Seg options={VIEWS.map((x) => ({ key: x.key, label: x.label }))} value={view} onChange={(k) => setView(k as View)} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next</span>
          <Seg options={HORIZONS.map((n) => ({ key: String(n), label: `${n} GW${n === 1 ? "" : "s"}` }))} value={String(h)} onChange={(k) => setH(Number(k))} />
        </div>
        <p className="w-full text-xs text-muted-foreground">• {v.label}: {v.blurb}</p>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Easiest → hardest, relative to every fixture shown:</span>
        {[...BANDS].reverse().map((b) => (
          <span key={b.label} className={`rounded px-2 py-0.5 font-semibold ${b.cls}`}>
            {b.label}
          </span>
        ))}
      </div>

      {/* ticker */}
      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">Team</th>
              <th className="px-2 py-2 text-left font-medium" title="0–10: average ease of the run (a double gameweek counts both games, a blank counts 0)">
                Run
              </th>
              {shown.map((g) => (
                <th key={g} className="px-1 py-2 text-center font-medium">
                  GW{g}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, run }, i) => (
              <tr key={t.id}>
                <td className="sticky left-0 z-10 border-t border-border/40 bg-card px-3 py-1.5">
                  <Link href={`/form/${t.short.toLowerCase()}`} className="flex items-center gap-2 hover:underline">
                    <span className="w-4 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element -- small decorative crest */}
                    <img src={t.crest} alt="" width={20} height={20} className="size-5 object-contain" loading="lazy" />
                    <span className="font-semibold">{t.short}</span>
                  </Link>
                </td>
                <td className="border-t border-border/40 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-7 font-semibold tabular-nums">{run.toFixed(1)}</span>
                    <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-border/60 sm:block" aria-hidden>
                      <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, run * 10)}%` }} />
                    </span>
                  </div>
                </td>
                {shown.map((g) => {
                  const fx = t.byGw[g] ?? [];
                  return (
                    <td key={g} className="border-t border-border/40 px-1 py-1.5">
                      {fx.length === 0 ? (
                        <span className="block rounded-md border border-dashed border-border px-1 py-1.5 text-center text-[11px] text-muted-foreground">Blank</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {fx.map((f, k) => {
                            const b = band(f);
                            const on = sel?.f === f;
                            return (
                              <button
                                key={k}
                                type="button"
                                onClick={() => setSel(on ? null : { team: t, f })}
                                title={`${t.short} ${f.home ? "v" : "@"} ${f.opp} · ${b.label}`}
                                className={`flex min-h-8 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-bold transition-transform hover:scale-[1.04] ${b.cls} ${on ? "ring-2 ring-sky-300 ring-offset-1 ring-offset-card" : ""}`}
                              >
                                {f.opp}
                                <span className="text-[9px] font-semibold opacity-70">{f.home ? "H" : "A"}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel ? (
        <Detail team={sel.team} f={sel.f} label={band(sel.f).label} cls={band(sel.f).cls} formGames={formGames} formWeight={formWeight} onClose={() => setSel(null)} />
      ) : (
        <p className="text-xs text-muted-foreground">• Tap any fixture to see the numbers behind its colour</p>
      )}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${value === o.key ? "bg-sky-500/20 text-sky-200" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Detail({ team, f, label, cls, formGames, formWeight, onClose }: {
  team: TickerTeam; f: TickerFixture; label: string; cls: string; formGames: number; formWeight: number; onClose: () => void;
}) {
  const w = Math.round(formWeight * 100);
  return (
    <section className="rise rounded-2xl border border-border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          GW{f.gw}: {team.short} {f.home ? "v" : "@"} {f.oppName}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${cls}`}>{label}</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
          Close
        </button>
      </div>
      <ul className="mt-2 space-y-0.5 text-muted-foreground">
        <li>
          • {f.oppName} over their last {f.oppForm.games}: {f.oppForm.res.split("").join(" ")} ({f.oppForm.pts} pts), scoring {f.oppForm.gf.toFixed(1)} and conceding{" "}
          {f.oppForm.ga.toFixed(1)} a game
        </li>
        <li>
          • From that form ({f.home ? "home" : "away"} adjusted): {team.short} {f.formGf.toFixed(1)} – {f.formGa.toFixed(1)}
        </li>
        {f.modelGf != null && f.modelGa != null ? (
          <li>
            • The model&apos;s expected goals: {team.short} {f.modelGf.toFixed(1)} – {f.modelGa.toFixed(1)}
          </li>
        ) : null}
        <li className="text-foreground">
          • Blend ({w}% form, {100 - w}% model): {team.short} expected to score {f.gf.toFixed(1)} and concede {f.ga.toFixed(1)}
        </li>
        <li>• The colour ranks this against every fixture shown, for the view you picked (form = last {formGames} league games)</li>
      </ul>
    </section>
  );
}
