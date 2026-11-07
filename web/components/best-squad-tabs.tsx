"use client";

import * as React from "react";
import { SquadPitch, type SquadPlayer } from "@/components/squad-pitch";
import type { BestSquadPlayer, GwPrediction, Position } from "@/lib/supabase";

const toSP = (p: BestSquadPlayer): SquadPlayer => ({
  fpl_id: p.fpl_id,
  web_name: p.web_name,
  position: p.position,
  team_short: p.team_short,
  now_cost: p.now_cost,
  status: "a",
  is_captain: p.is_captain,
  is_vice_captain: false,
  xp_next: p.xpn,
  why: [p.is_start ? "In the best XI for this gameweek" : "On the bench of the best squad for this gameweek"],
});

const TABS: { key: "capped" | "uncapped"; label: string; sub: string }[] = [
  { key: "capped", label: "£100m cap", sub: "the best team you could actually build" },
  { key: "uncapped", label: "No cap", sub: "the best team if money were no object" },
];

export function BestSquadTabs({
  capped,
  uncapped,
  opponents,
}: {
  capped: GwPrediction | null;
  uncapped: GwPrediction | null;
  opponents?: Record<string, string>; // each club's opponent(s) that GW (lib/fixtures.ts)
}) {
  const [variant, setVariant] = React.useState<"capped" | "uncapped">("capped");
  const pred = variant === "capped" ? capped : uncapped;
  const active = TABS.find((t) => t.key === variant)!;

  const squad = pred?.squad ?? [];
  const starters = squad.filter((p) => p.is_start);
  const bench = squad.filter((p) => !p.is_start);
  const byPos = (pos: Position) => starters.filter((p) => p.position === pos).map(toSP);
  const cost = squad.reduce((s, p) => s + p.now_cost, 0) / 10;
  const captain = squad.find((p) => p.is_captain);

  return (
    <div>
      {/* sub-tabs */}
      <div className="inline-flex rounded-lg border border-border/60 bg-card p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setVariant(t.key)}
            className={
              variant === t.key
                ? "rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-400"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{active.sub}.</p>

      {squad.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border/60 bg-card px-4 py-6 text-sm text-muted-foreground">
          No best XI yet — run the predictions pipeline (needs migration 0003).
        </p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3">
            {[
              { label: "Predicted pts", value: pred?.predicted_pts?.toFixed(1) ?? "—" },
              { label: "Squad cost", value: `£${cost.toFixed(1)}m` },
              { label: "Captain", value: captain?.web_name ?? "—" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border/60 bg-card px-3 py-3 shadow-sm sm:px-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
                <div className="mt-1 truncate text-base font-semibold sm:text-lg">{s.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <SquadPitch
              gk={byPos("GK")}
              def={byPos("DEF")}
              mid={byPos("MID")}
              fwd={byPos("FWD")}
              bench={bench.map(toSP)}
              opponents={opponents}
            />
          </div>
        </>
      )}
    </div>
  );
}
