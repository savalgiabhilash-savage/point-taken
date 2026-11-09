"use client";

import * as React from "react";
import type { ComparePlayer } from "@/lib/compare";
import type { CompareDetail } from "@/lib/compare-detail";

// The horizon-based half of the Compare page: verdict, points outlook (range), where the points come from,
// gameweek by gameweek, and grouped key numbers. Data comes from lib/compare-detail.ts (server).

type Better = "high" | "low" | null;
type P = { p: ComparePlayer; d: CompareDetail | undefined; color: string };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/** Index of the best value, or -1 for a tie, missing values or a neutral row. */
export function bestIndex(vals: (number | null)[], better: Better): number {
  if (!better) return -1;
  const real = vals.map((v, i) => [v, i] as const).filter(([v]) => v != null) as [number, number][];
  if (real.length < 2) return -1;
  real.sort((a, b) => (better === "high" ? b[0] - a[0] : a[0] - b[0]));
  return real[0][0] === real[1][0] ? -1 : real[0][1];
}

export function fdrClass(fdr: number | null): string {
  if (fdr == null) return "bg-muted text-muted-foreground";
  if (fdr < 2) return "bg-emerald-500/20 text-emerald-300";
  if (fdr < 2.75) return "bg-lime-500/20 text-lime-300";
  if (fdr < 3.5) return "bg-amber-500/20 text-amber-300";
  if (fdr < 4.25) return "bg-orange-500/20 text-orange-300";
  return "bg-rose-500/20 text-rose-300";
}

// Same colours as the xPts breakdown elsewhere in the app (Guide → "The xPts breakdown").
const COMPS = [
  { key: "appearance", label: "Appearance", cls: "bg-zinc-400" },
  { key: "goals", label: "Goals", cls: "bg-emerald-500" },
  { key: "assists", label: "Assists", cls: "bg-sky-500" },
  { key: "cs", label: "Clean sheet", cls: "bg-teal-500" },
  { key: "bonus", label: "Bonus", cls: "bg-violet-500" },
  { key: "defcon", label: "DefCon", cls: "bg-amber-500" },
  { key: "saves", label: "Saves", cls: "bg-cyan-500" },
] as const;

function Card({ title, note, children, pending }: { title: string; note?: React.ReactNode; children: React.ReactNode; pending: boolean }) {
  return (
    <section className={`rounded-xl border border-border bg-card p-4 transition-opacity ${pending ? "opacity-50" : ""}`} aria-busy={pending}>
      <h2 className="font-display text-lg">{title}</h2>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Name({ x }: { x: P }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: x.color }} />
      <span className="truncate">{x.p.name}</span>
    </span>
  );
}

type TRow = { label: string; vals: (number | null)[]; fmt: (v: number) => string; better: Better; text?: string[] };
function Table({ group, rows, ps }: { group: string; rows: TRow[]; ps: P[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="py-2 pr-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</th>
            {ps.map((x) => (
              <th key={x.p.id} className="py-2 pl-3 text-right font-display"><Name x={x} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const best = bestIndex(r.vals, r.better);
            return (
              <tr key={r.label} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-3 text-muted-foreground">{r.label}</td>
                {r.vals.map((v, i) => (
                  <td key={i} className={`py-2 pl-3 text-right tabular-nums ${best === i ? "font-semibold text-emerald-400" : ""}`}>
                    {r.text ? r.text[i] : v == null ? "—" : r.fmt(v)}
                    {best === i ? " ▲" : ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The app's pick. Same goal as the Optimizer: the most expected points over the chosen horizon. When the
// top two are within CLOSE pts per GW (well inside the model's error), it's called close and the tie-break is
// money first (a pick £0.5m+ cheaper frees budget elsewhere), then the safer floor.
const CLOSE = 0.3;
const COMP_LABEL: Record<string, string> = { appearance: "appearance", goals: "goals", assists: "assists", cs: "clean sheets", bonus: "bonus", defcon: "DefCon", saves: "saves", deductions: "fewer deductions" };

function recommend(ps: P[], h: number): { pick: P; close: boolean; bullets: string[] } {
  const byXp = [...ps].sort((a, b) => b.d!.xp - a.d!.xp);
  const [a, b] = byXp;
  const gapPerGw = (a.d!.xp - b.d!.xp) / h;
  const span = h === 1 ? "next GW" : `next ${h} GWs`;
  const near = byXp.filter((x) => (a.d!.xp - x.d!.xp) / h < CLOSE);
  const close = near.length > 1;

  let pick = a;
  let why: string;
  if (!close) {
    why = `Most expected points over the ${span}: ${f1(a.d!.xp)}, ${f1(a.d!.xp - b.d!.xp)} more than ${b.p.name} (${f2(gapPerGw)} a GW)`;
  } else {
    const cheapest = [...near].sort((x, y) => x.p.price - y.p.price)[0];
    const priciest = [...near].sort((x, y) => y.p.price - x.p.price)[0];
    if (priciest.p.price - cheapest.p.price >= 0.5) {
      pick = cheapest;
      why = `Too close to call on points (within ${CLOSE} a GW), and ${cheapest.p.name} is £${(priciest.p.price - cheapest.p.price).toFixed(1)}m cheaper than ${priciest.p.name}: spend the saving elsewhere`;
    } else {
      pick = [...near].sort((x, y) => y.d!.lo - x.d!.lo)[0];
      why = `Too close to call on points (within ${CLOSE} a GW); ${pick.p.name} has the safer floor (bad case ${f1(pick.d!.lo)} pts)`;
    }
  }

  const bullets = [why];
  const rival = byXp.find((x) => x !== pick)!;
  // Where his edge (or deficit) comes from: the scoring route with the biggest difference.
  const diffs = (Object.keys(pick.d!.comps) as (keyof CompareDetail["comps"])[]).map((k) => [k, pick.d!.comps[k] - rival.d!.comps[k]] as const);
  const [k, v] = [...diffs].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
  if (Math.abs(v) >= 0.3) bullets.push(`Biggest difference vs ${rival.p.name}: ${COMP_LABEL[k]} (${v > 0 ? "+" : ""}${f1(v)} pts)`);
  if (pick.d!.pStart < 0.75) bullets.push(`Minutes risk: ${pct(pick.d!.pStart)} chance to start`);
  if (pick.d!.lo < rival.d!.lo - 0.5) bullets.push(`Lower floor than ${rival.p.name} (bad case ${f1(pick.d!.lo)} vs ${f1(rival.d!.lo)})`);
  if (pick.p.price > rival.p.price) bullets.push(`Costs £${(pick.p.price - rival.p.price).toFixed(1)}m more than ${rival.p.name}`);
  if (h === 1) {
    const cap = [...ps].sort((x, y) => y.d!.xp - x.d!.xp || y.d!.gws[0].pHaul - x.d!.gws[0].pHaul)[0];
    bullets.push(`Captain between them: ${cap.p.name} (${f1(cap.d!.xp * 2)} expected as captain, ${pct(cap.d!.gws[0].pHaul)} chance of 20+)`);
  }
  if (ps.length === 3) {
    const third = byXp[2];
    if (third !== pick) bullets.push(`${third.p.name} trails the leader by ${f1(a.d!.xp - third.d!.xp)} pts`);
  }
  return { pick, close, bullets };
}

function Recommendation({ ps, h, pending }: { ps: P[]; h: number; pending: boolean }) {
  const { pick, close, bullets } = recommend(ps, h);
  return (
    <section
      className={`relative overflow-hidden rounded-xl border bg-card p-4 transition-opacity ${pending ? "opacity-50" : ""}`}
      style={{ borderColor: pick.color }}
      aria-busy={pending}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: pick.color }} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block -skew-x-12 bg-grad px-2 py-0.5">
          <span className="inline-block skew-x-12 text-[11px] font-bold uppercase tracking-[0.16em]">App pick</span>
        </span>
        {close && <span className="text-xs text-muted-foreground">Close call</span>}
      </div>
      <h2 className="mt-2 font-display text-2xl">
        <span style={{ color: pick.color }}>{pick.p.name}</span>{" "}
        <span className="text-base text-muted-foreground">{pick.p.team} · {pick.p.pos} · £{pick.p.price.toFixed(1)}m</span>
      </h2>
      <ul className="mt-2 space-y-1 text-sm">
        {bullets.map((b) => <li key={b}>• {b}</li>)}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">• Picked on expected points over the {h === 1 ? "next GW" : `next ${h} GWs`}, the same goal the Optimizer uses; change the horizon above to re-check</p>
    </section>
  );
}

export function CompareDetails({ ps, h, pending }: { ps: P[]; h: number; pending: boolean }) {
  const ready = ps.every((x) => x.d);
  if (!ready) {
    return <p className="text-sm text-muted-foreground" role="status">• Loading the comparison…</p>;
  }
  const D = ps.map((x) => x.d!) as CompareDetail[];
  const span = h === 1 ? "next GW" : `next ${h} GWs`;
  const by = <T,>(f: (d: CompareDetail, p: ComparePlayer) => T) => ps.map((x) => f(x.d!, x.p));
  const top = (f: (d: CompareDetail, p: ComparePlayer) => number) => [...ps].sort((a, b) => f(b.d!, b.p) - f(a.d!, a.p));

  // Verdict lines.
  const most = top((d) => d.xp);
  const safest = top((d) => d.lo);
  const upside = top((d) => d.hi);
  const value = top((d, p) => (p.price ? d.xp / p.price : 0));
  const defcon = top((d) => d.pDc);

  const scaleMax = Math.max(...D.map((d) => d.hi), 1) * 1.05;
  const compMax = Math.max(...D.map((d) => COMPS.reduce((s, c) => s + Math.max(0, d.comps[c.key]), 0)), 1);

  return (
    <div className="space-y-6">
      <Recommendation ps={ps} h={h} pending={pending} />

      <Card title="Verdict" pending={pending}>
        <ul className="space-y-1 text-sm">
          <li>• Most points, {span}: <b>{most[0].p.name}</b> {f1(most[0].d!.xp)}, {f1(most[0].d!.xp - most[1].d!.xp)} more than {most[1].p.name}</li>
          <li>• Safest floor: <b>{safest[0].p.name}</b> (bad case {f1(safest[0].d!.lo)} pts)</li>
          <li>• Biggest upside: <b>{upside[0].p.name}</b> (good case {f1(upside[0].d!.hi)} pts{h > 1 ? `, ${pct(upside[0].d!.pHaulAny)} chance of a 10+ week` : `, ${pct(upside[0].d!.gws[0].pHaul)} chance of 10+`})</li>
          <li>• Best value: <b>{value[0].p.name}</b> ({f2(value[0].d!.xp / value[0].p.price)} xPts per £1m)</li>
          {defcon[0].d!.pDc >= 0.2 && <li>• Best DefCon bet: <b>{defcon[0].p.name}</b> ({pct(defcon[0].d!.pDc)} chance per game of the 2 DefCon points)</li>}
        </ul>
      </Card>

      <Card
        title={`Points outlook · ${span}`}
        pending={pending}
        note={
          h === 1
            ? "• Bar = likely range (8 games in 10 land inside it, from 2,000 simulated games); line = expected points; dot = median"
            : "• Bar = likely range over the period (8 in 10 outcomes; weekly simulated ranges combined as independent weeks); line = expected points"
        }
      >
        <div className="space-y-3">
          {ps.map((x) => {
            const d = x.d!;
            const left = (d.lo / scaleMax) * 100;
            const width = Math.max(1, ((d.hi - d.lo) / scaleMax) * 100);
            return (
              <div key={x.p.id}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <Name x={x} />
                  <span className="tabular-nums">
                    <b className="font-display text-lg">{f1(d.xp)}</b>{" "}
                    <span className="text-muted-foreground">({f1(d.lo)}–{f1(d.hi)})</span>
                  </span>
                </div>
                <div className="relative mt-1 h-4 rounded-sm bg-muted">
                  <div className="absolute inset-y-0 rounded-sm" style={{ left: `${left}%`, width: `${width}%`, backgroundColor: x.color, opacity: 0.35 }} />
                  <div className="absolute inset-y-[-3px] w-[3px] rounded-full" style={{ left: `calc(${(d.xp / scaleMax) * 100}% - 1.5px)`, backgroundColor: x.color }} />
                  {d.median1 != null && (
                    <div className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground" style={{ left: `${(d.median1 / scaleMax) * 100}%` }} />
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {h === 1
                    ? `• ${pct(d.gws[0].pHaul)} chance of 10+ pts (20+ as captain) · ${pct(d.gws[0].pBlank)} chance of 2 or fewer`
                    : `• ${pct(d.pHaulAny)} chance of at least one 10+ week · about ${f1(d.blanks)} of ${h} weeks on 2 pts or fewer`}
                </div>
              </div>
            );
          })}
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums"><span>0</span><span>{Math.round(scaleMax)} pts</span></div>
        </div>
      </Card>

      <Card title={`Where the points come from · ${span}`} pending={pending} note="• Expected points from each scoring route; deductions (goals conceded, cards) are taken off the total">
        <div className="space-y-3">
          {ps.map((x) => {
            const d = x.d!;
            return (
              <div key={x.p.id}>
                <div className="flex items-baseline justify-between text-sm">
                  <Name x={x} />
                  <span className="text-xs tabular-nums text-muted-foreground">deductions {f1(d.comps.deductions)}</span>
                </div>
                <div className="mt-1 flex h-4 overflow-hidden rounded-sm bg-muted">
                  {COMPS.map((c) => {
                    const v = Math.max(0, d.comps[c.key]);
                    return v > 0 ? <div key={c.key} title={`${c.label} ${f1(v)}`} className={c.cls} style={{ width: `${(v / compMax) * 100}%` }} /> : null;
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {COMPS.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1"><span className={`size-2 rounded-sm ${c.cls}`} />{c.label}</span>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <Table
            group="Points from"
            ps={ps}
            rows={[
              ...COMPS.map((c) => ({ label: c.label, vals: by((d) => d.comps[c.key]), fmt: f1, better: "high" as Better })),
              { label: "Deductions", vals: by((d) => d.comps.deductions), fmt: f1, better: "high" as Better },
              { label: "Total xPts", vals: by((d) => d.xp), fmt: f1, better: "high" as Better },
            ]}
          />
        </div>
      </Card>

      <Card title="Gameweek by gameweek" pending={pending} note="• Expected points per GW, with the opponent coloured by difficulty">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">GW</th>
                {ps.map((x) => <th key={x.p.id} className="py-2 pl-3 text-right font-display normal-case tracking-normal text-foreground"><Name x={x} /></th>)}
              </tr>
            </thead>
            <tbody>
              {D[0].gws.map((g, gi) => {
                const vals = D.map((d) => d.gws[gi]?.xp ?? null);
                const best = bestIndex(vals, "high");
                return (
                  <tr key={g.gw} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 text-muted-foreground">GW{g.gw}</td>
                    {D.map((d, i) => {
                      const cell = d.gws[gi];
                      return (
                        <td key={i} className="py-2 pl-3 text-right">
                          <span className={`mr-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${fdrClass(cell.fdr)}`}>{cell.opp}</span>
                          <span className={`tabular-nums ${best === i ? "font-semibold text-emerald-400" : ""}`}>{f1(cell.xp)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="DefCon & defence" pending={pending} note="• DefCon: 2 pts for reaching the defensive-contribution threshold in a game (10 for defenders, 12 for midfielders and forwards)">
        <Table
          group={span}
          ps={ps}
          rows={[
            { label: "DefCon chance per game", vals: by((d) => d.pDc), fmt: pct, better: "high" },
            { label: "Defensive actions per 90", vals: by((d) => d.dc90), fmt: f1, better: "high" },
            { label: "DefCon points", vals: by((d) => d.comps.defcon), fmt: f1, better: "high" },
            // Forwards don't score clean-sheet points, so their team's clean-sheet chance isn't shown.
            { label: "Clean-sheet chance per game", vals: by((d, p) => (p.pos === "FWD" ? null : d.pCs)), fmt: pct, better: "high" },
            { label: "Clean-sheet points", vals: by((d) => d.comps.cs), fmt: f1, better: "high" },
            { label: "Team xG against per game", vals: by((d) => d.teamXgAgainst), fmt: f2, better: "low" },
          ]}
        />
      </Card>

      <Card title="Attack" pending={pending}>
        <Table
          group={span}
          ps={ps}
          rows={[
            { label: "xG per 90 (season)", vals: by((_, p) => p.xg90), fmt: f2, better: "high" },
            { label: "xA per 90 (season)", vals: by((_, p) => p.xa90), fmt: f2, better: "high" },
            { label: "Share of team's xG", vals: by((d) => d.xgShare), fmt: pct, better: "high" },
            { label: "Share of team's xA", vals: by((d) => d.xaShare), fmt: pct, better: "high" },
            { label: "Team xG per game", vals: by((d) => d.teamXgFor), fmt: f2, better: "high" },
            { label: "Bonus per 90", vals: by((d) => d.bonus90), fmt: f2, better: "high" },
            { label: "Set pieces", vals: by(() => null), fmt: String, better: null, text: by((d) => (d.setpieces.length ? d.setpieces.join(", ") : "—")) },
          ]}
        />
      </Card>

      <Card title="Minutes" pending={pending}>
        <Table
          group={span}
          ps={ps}
          rows={[
            { label: "Chance to start", vals: by((d) => d.pStart), fmt: pct, better: "high" },
            { label: "Chance of 60+ minutes", vals: by((d) => d.p60), fmt: pct, better: "high" },
            { label: "Expected minutes per game", vals: by((d) => d.minsPerGame), fmt: (v) => `${v}′`, better: "high" },
          ]}
        />
      </Card>

      <Card title="Fixtures & market" pending={pending}>
        <Table
          group={span}
          ps={ps}
          rows={[
            { label: "Fixture difficulty (avg)", vals: by((d) => d.fdr), fmt: f1, better: "low" },
            { label: "xPts per £1m", vals: by((d, p) => (p.price ? d.xp / p.price : 0)), fmt: f2, better: "high" },
            { label: "Form", vals: by((_, p) => p.form), fmt: f1, better: "high" },
            { label: "Season points", vals: by((_, p) => p.totalPts), fmt: String, better: "high" },
            { label: "Price", vals: by((_, p) => p.price), fmt: (v) => `£${v.toFixed(1)}m`, better: null },
            { label: "Owned by", vals: by((_, p) => p.own), fmt: (v) => `${v.toFixed(1)}%`, better: null },
          ]}
        />
      </Card>
    </div>
  );
}
