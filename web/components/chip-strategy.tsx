"use client";

import * as React from "react";
import { PlayerInfo } from "@/components/player-info";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";
import type { Position } from "@/lib/supabase";

// Shapes written by worker/fpl_worker/optimize.py (_chip_plan -> transfers.chips[].options).
export type ChipCard = {
  fpl_id: number;
  web_name: string;
  position: Position | null;
  team_short: string;
  now_cost: number | null;
  xp: number;
  is_start?: boolean;
  is_captain?: boolean;
};
export type ChipOption = {
  gw: number;
  gain: number;
  captain?: ChipCard | null;
  bench?: ChipCard[];
  out?: ChipCard[];
  in?: ChipCard[];
  squad?: ChipCard[];
};
export type ChipEntry = {
  chip: string;
  gw: number;
  gain: number;
  detail: string;
  available: boolean;
  threshold?: number;
  half?: number;
  gw_type?: string;
  options: ChipOption[];
};

const ORDER = ["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"];
const STYLE: Record<string, string> = {
  "Triple Captain": "text-violet-400",
  "Bench Boost": "text-sky-400",
  Wildcard: "text-emerald-400",
  "Free Hit": "text-amber-400",
};

export function ChipStrategy({
  chips,
  ownership,
  opponentsByGw = {},
}: {
  chips: ChipEntry[];
  ownership: Record<number, number>;
  opponentsByGw?: Record<number, Record<string, string>>; // {gw: {teamShort: "v BOU"}} (lib/fixtures.ts)
}) {
  const sorted = [...chips].sort(
    (a, b) => (a.half ?? 1) - (b.half ?? 1) || ORDER.indexOf(a.chip) - ORDER.indexOf(b.chip),
  );
  const key = (c: ChipEntry) => `${c.chip}-${c.half ?? 1}`;
  const [sel, setSel] = React.useState(key(sorted[0]));
  const chip = sorted.find((c) => key(c) === sel) ?? sorted[0];
  const [gw, setGw] = React.useState<number>(chip.gw);
  const opt = chip.options.find((o) => o.gw === gw) ?? chip.options[0];
  const bar = chip.threshold ?? 0;

  return (
    <div className="mt-6 space-y-5">
      {/* chip picker */}
      <div className="flex flex-wrap gap-2">
        {sorted.map((c) => {
          const recommended = c.available && c.gain > 0 && c.gain >= (c.threshold ?? 0);
          return (
            <button
              key={key(c)}
              type="button"
              onClick={() => {
                setSel(key(c));
                setGw(c.gw); // jump to that chip's best week
              }}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                key(c) === sel ? "border-emerald-500/50 bg-emerald-500/10" : "border-border/60 bg-card hover:border-border"
              }`}
            >
              <div className={`font-semibold ${STYLE[c.chip] ?? ""}`}>
                {c.chip}
                {c.half === 2 ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">GW20–38 set</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {!c.available ? "used" : recommended ? `play GW${c.gw} · +${c.gain.toFixed(1)}` : `best GW${c.gw} · +${c.gain.toFixed(1)}`}
              </div>
            </button>
          );
        })}
      </div>

      {/* status */}
      <div className="rounded-2xl border border-border bg-card px-4 py-3">
        <ul className="space-y-0.5 text-sm">
          <li>
            • {chip.available ? "You still have this chip" : "Already used in this half of the season"}
            {chip.half ? ` (${chip.half === 1 ? "GW1–19 set, expires after GW19" : "GW20–38 set"})` : ""}
          </li>
          <li>
            • Best week in your plan: GW{chip.gw}, +{chip.gain.toFixed(1)} pts
            {chip.gw_type ? ` (${chip.gw_type === "DGW" ? "Double" : "Blank"} gameweek)` : ""}
          </li>
          <li>
            • Bar to recommend it: +{bar.toFixed(0)} pts
            {chip.gain >= bar && chip.gain > 0 ? " (cleared)" : " (not cleared: holding it is better so far)"}
          </li>
          {chip.detail.split(";").map((d, i) => (
            <li key={i}>• {d.trim().replace(/^./, (x) => x.toUpperCase())}</li>
          ))}
        </ul>
      </div>

      {/* gameweek picker */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          If you play it in…
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chip.options.map((o) => (
            <button
              key={o.gw}
              type="button"
              onClick={() => setGw(o.gw)}
              className={`rounded-md border px-2.5 py-1 text-xs tabular-nums ${
                o.gw === gw ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              GW{o.gw} · {o.gain >= 0 ? "+" : ""}
              {o.gain.toFixed(1)}
            </button>
          ))}
        </div>
      </div>

      {opt ? <OptionView chip={chip.chip} opt={opt} ownership={ownership} opponents={opponentsByGw[opt.gw]} /> : null}
    </div>
  );
}

function OptionView({
  chip,
  opt,
  ownership,
  opponents,
}: {
  chip: string;
  opt: ChipOption;
  ownership: Record<number, number>;
  opponents?: Record<string, string>;
}) {
  const gain = `${opt.gain >= 0 ? "+" : ""}${opt.gain.toFixed(1)} pts`;
  if (chip === "Triple Captain") {
    const c = opt.captain;
    return (
      <Panel
        title={`Triple Captain in GW${opt.gw}`}
        bullets={[
          c ? `Captain: ${c.web_name} (${c.team_short}), projected ${c.xp.toFixed(1)} pts` : "No captain available",
          `Triple Captain adds his points a third time: ${gain}`,
          "Before the deadline: activate Triple Captain in the FPL app and keep him as captain",
          "Pick a vice-captain who is certain to start, in case he misses out",
        ]}
      >
        {c ? <CardList cards={[c]} ownership={ownership} why={() => [`Your captain in GW${opt.gw}: the highest projection in your XI`]} /> : null}
      </Panel>
    );
  }
  if (chip === "Bench Boost") {
    const bench = opt.bench ?? [];
    return (
      <Panel
        title={`Bench Boost in GW${opt.gw}`}
        bullets={[
          `Your 4 bench players would add ${gain}`,
          "Before the deadline: activate Bench Boost in the FPL app",
          "Check all 4 have a fixture that week and aren't flagged; swap out any who are",
          "Cheap bench players with good fixtures raise the gain; the Optimizer can plan transfers toward this week",
        ]}
      >
        <CardList cards={bench} ownership={ownership} why={(p) => [`On your bench in GW${opt.gw}: Bench Boost counts his ${p.xp.toFixed(1)} projected pts`]} />
      </Panel>
    );
  }
  // Wildcard / Free Hit: a new squad
  const outs = opt.out ?? [];
  const ins = opt.in ?? [];
  const squad = opt.squad ?? [];
  const toSP = (p: ChipCard): SquadPlayer => ({
    fpl_id: p.fpl_id,
    web_name: p.web_name,
    position: p.position,
    team_short: p.team_short,
    now_cost: p.now_cost,
    status: "a",
    is_captain: !!p.is_captain,
    is_vice_captain: false,
    xp_next: p.xp,
    ownership: ownership[p.fpl_id] ?? null,
    why: [`In the ${chip} squad for GW${opt.gw}`, p.is_start ? "Starts in that XI" : "On the bench"],
  });
  const starters = squad.filter((p) => p.is_start);
  const byPos = (pos: Position) => starters.filter((p) => p.position === pos).map(toSP);
  const bullets =
    chip === "Free Hit"
      ? [
          `A one-week squad for GW${opt.gw}: ${gain} vs your planned team that week`,
          `${outs.length} change${outs.length === 1 ? "" : "s"}, all free; your squad returns to normal the week after`,
          "Before the deadline: activate Free Hit, then make the transfers below",
          "Best used when many of your players blank or have tough fixtures",
        ]
      : [
          `Rebuild from GW${opt.gw}: ${gain} over your planned transfers for the rest of the plan (including hits saved)`,
          `${outs.length} change${outs.length === 1 ? "" : "s"}, all free; the new squad is permanent`,
          "Before the deadline: activate Wildcard, then make the transfers below",
          "Budget uses your real selling prices, so the squad is affordable",
        ];
  return (
    <Panel title={`${chip} in GW${opt.gw}`} bullets={bullets}>
      {outs.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-rose-300">Out ({outs.length})</div>
            <CardList cards={outs} ownership={ownership} why={() => [`Sold for the ${chip} squad in GW${opt.gw}`]} />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-emerald-300">In ({ins.length})</div>
            <CardList cards={ins} ownership={ownership} why={() => [`Bought for the ${chip} squad in GW${opt.gw}`]} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">• No changes: your planned squad is already the best for this chip</p>
      )}
      {squad.length ? (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Resulting squad</div>
          <SquadPitch gk={byPos("GK")} def={byPos("DEF")} mid={byPos("MID")} fwd={byPos("FWD")} bench={squad.filter((p) => !p.is_start).map(toSP)} opponents={opponents} />
        </div>
      ) : null}
    </Panel>
  );
}

function Panel({ title, bullets, children }: { title: string; bullets: string[]; children?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-4">
      <div className="text-sm font-semibold">{title}</div>
      <ul className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
        {bullets.map((b, i) => (
          <li key={i}>• {b}</li>
        ))}
      </ul>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

function CardList({
  cards,
  ownership,
  why,
}: {
  cards: ChipCard[];
  ownership: Record<number, number>;
  why: (p: ChipCard) => string[];
}) {
  return (
    <ul className="space-y-1.5">
      {cards.map((p) => {
        const own = ownership[p.fpl_id];
        return (
          <li key={p.fpl_id} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-sm">
            <span className="w-8 text-[10px] font-bold text-muted-foreground">{p.position}</span>
            <span className="flex-1 truncate font-medium">
              {p.web_name} <span className="text-xs font-normal text-muted-foreground">{p.team_short}</span>
            </span>
            {own != null && own < 10 ? (
              <span className="rounded bg-violet-600 px-1 text-[9px] font-bold text-white" title={`${own.toFixed(1)}% owned`}>
                D
              </span>
            ) : null}
            <span className="tabular-nums text-xs text-muted-foreground">
              {p.now_cost != null ? `£${(p.now_cost / 10).toFixed(1)}` : ""}
            </span>
            <span className="w-10 text-right tabular-nums font-semibold">{p.xp.toFixed(1)}</span>
            <PlayerInfo playerId={p.fpl_id} name={p.web_name} why={why(p)} />
          </li>
        );
      })}
    </ul>
  );
}
