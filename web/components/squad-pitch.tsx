import type { Position } from "@/lib/supabase";
import { PlayerInfo } from "@/components/player-info";

export type SquadPlayer = {
  fpl_id: number;
  web_name: string;
  position: Position | null;
  team_short: string;
  now_cost: number | null;
  status: string | null;
  is_captain: boolean;
  is_vice_captain: boolean;
  xp_next: number | null;
  xp_horizon?: number | null; // projected pts over the plan horizon (optimizer only)
  note?: string | null; // short "why this player" note (optimizer only)
  why?: string[]; // page-specific reasons shown first in the "i" pop-up
  ownership?: number | null; // % owned — under 10% gets a differential badge
};

const DIFFERENTIAL_OWNERSHIP = 10;

const POS_ACCENT: Record<Position, string> = {
  GK: "bg-amber-400",
  DEF: "bg-emerald-400",
  MID: "bg-sky-400",
  FWD: "bg-rose-400",
};

const STATUS_DOT: Record<string, string> = {
  a: "bg-emerald-500",
  d: "bg-amber-500",
  i: "bg-red-500",
  s: "bg-red-500",
  u: "bg-zinc-400",
  n: "bg-zinc-400",
};

const STATUS_LABEL: Record<string, string> = {
  a: "Available",
  d: "Doubtful",
  i: "Injured",
  s: "Suspended",
  u: "Unavailable",
  n: "Not in squad",
};

function xpChip(v: number | null): string {
  if (v == null) return "bg-muted text-muted-foreground";
  if (v >= 6) return "bg-emerald-600 text-white";
  if (v >= 4.5) return "bg-emerald-500/85 text-white";
  if (v >= 3) return "bg-emerald-500/45 text-emerald-950";
  if (v >= 1.5) return "bg-emerald-500/25 text-emerald-950";
  return "bg-zinc-200 text-zinc-700";
}

// "Why this pick" bullets for the pop-up: the page's own reasons plus what this card shows.
function cardWhy(p: SquadPlayer): string[] {
  const out = [...(p.why ?? [])];
  if (p.is_captain) out.push("Captain: highest projection in the XI, so his points count double");
  if (p.is_vice_captain && !p.is_captain) out.push("Vice-captain: takes the armband if the captain doesn't play");
  if (p.xp_horizon != null) out.push(`${p.xp_horizon.toFixed(1)} pts projected over the plan`);
  if (p.note) out.push(p.note);
  if (p.status && p.status !== "a") out.push(`Status: ${STATUS_LABEL[p.status] ?? p.status}`);
  return out;
}

function PlayerCard({ p, opp }: { p: SquadPlayer; opp?: string | null }) {
  const dot = STATUS_DOT[p.status ?? "a"] ?? STATUS_DOT.a;
  const price = p.now_cost == null ? null : (p.now_cost / 10).toFixed(1);
  return (
    // Outer wrapper is NOT clipped, so the corner badges can sit on the card edge.
    <div className="group/card relative w-[72px] sm:w-[84px]">
      <div className="flex w-full flex-col items-center overflow-hidden rounded-lg bg-white/95 shadow-md ring-1 ring-black/10">
        <div className={`h-1 w-full ${p.position ? POS_ACCENT[p.position] : "bg-zinc-300"}`} />
        {(p.is_captain || p.is_vice_captain) && (
          <span
            className={`absolute right-1 top-2 z-10 flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${
              p.is_captain ? "bg-zinc-900" : "bg-zinc-500"
            }`}
            title={p.is_captain ? "Captain" : "Vice-captain"}
          >
            {p.is_captain ? "C" : "V"}
          </span>
        )}
        <div className="flex w-full flex-col items-center gap-0.5 px-1 py-1.5">
          <div className="flex items-center gap-1">
            <span className={`size-1.5 rounded-full ${dot}`} />
            <span className="max-w-[64px] truncate text-[11px] font-semibold text-zinc-900">
              {p.web_name}
            </span>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-700">{p.team_short}</span>
          {opp !== undefined && (
            <span className="max-w-[80px] truncate text-[9px] text-zinc-500" title={opp ?? "No game this gameweek"}>
              {opp ?? "no game"}
            </span>
          )}
          <span className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${xpChip(p.xp_next)}`}>
            {p.xp_next == null ? "—" : p.xp_next.toFixed(1)}
          </span>
          <span className="text-[9px] text-zinc-500">{price == null ? "" : `£${price}`}</span>
        </div>
      </div>

      {/* "i": click for the full factor-by-factor reasoning (works on tap and keyboard too). */}
      <div className="absolute left-1 top-2 z-10">
        <PlayerInfo
          playerId={p.fpl_id}
          name={p.web_name}
          why={cardWhy(p)}
          className="flex size-4 cursor-pointer items-center justify-center rounded-full bg-zinc-900/70 font-serif text-[10px] font-bold italic leading-none text-white hover:bg-emerald-600"
        />
      </div>
      {p.ownership != null && p.ownership < DIFFERENTIAL_OWNERSHIP ? (
        <span
          className="absolute bottom-1 right-1 z-10 rounded bg-violet-600 px-1 text-[8px] font-bold text-white"
          title={`Differential: ${p.ownership.toFixed(1)}% owned`}
        >
          D
        </span>
      ) : null}
    </div>
  );
}

// opponents: { teamShort: "v BOU (H)" | "v AVL (A)" } for the GW shown (lib/fixtures.ts); omitted = no opponent line.
function Row({ players, opponents }: { players: SquadPlayer[]; opponents?: Record<string, string> }) {
  return (
    <div className="flex justify-center gap-2 sm:gap-4">
      {players.map((p) => (
        <PlayerCard key={p.fpl_id} p={p} opp={opponents ? (opponents[p.team_short] ?? null) : undefined} />
      ))}
    </div>
  );
}

export function SquadPitch({
  gk,
  def,
  mid,
  fwd,
  bench,
  opponents,
}: {
  gk: SquadPlayer[];
  def: SquadPlayer[];
  mid: SquadPlayer[];
  fwd: SquadPlayer[];
  bench: SquadPlayer[];
  opponents?: Record<string, string>; // each club's opponent(s) in the GW this pitch shows
}) {
  return (
    <div className="space-y-4">
      {/* pitch */}
      <div
        className="rounded-2xl border border-emerald-900/20 p-4 shadow-inner sm:p-6"
        style={{
          background:
            "repeating-linear-gradient(180deg, oklch(0.62 0.13 152) 0 44px, oklch(0.59 0.13 152) 44px 88px)",
        }}
      >
        <div className="flex flex-col justify-between gap-5 sm:gap-7 [min-height:26rem]">
          <Row players={gk} opponents={opponents} />
          <Row players={def} opponents={opponents} />
          <Row players={mid} opponents={opponents} />
          <Row players={fwd} opponents={opponents} />
        </div>
      </div>

      {/* bench */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Bench
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
          <Row players={bench} opponents={opponents} />
        </div>
      </div>
    </div>
  );
}
