import type { Position } from "@/lib/supabase";

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
};

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

function PlayerCard({ p }: { p: SquadPlayer }) {
  const dot = STATUS_DOT[p.status ?? "a"] ?? STATUS_DOT.a;
  const price = p.now_cost == null ? null : (p.now_cost / 10).toFixed(1);
  return (
    // Outer wrapper is NOT clipped, so the hover/focus tooltip can escape the card.
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
          <span className="text-[9px] uppercase tracking-wide text-zinc-500">{p.team_short}</span>
          <span className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${xpChip(p.xp_next)}`}>
            {p.xp_next == null ? "—" : p.xp_next.toFixed(1)}
          </span>
          <span className="text-[9px] text-zinc-500">{price == null ? "" : `£${price}`}</span>
        </div>
      </div>

      {/* Info affordance — a focusable "i" so it also works on tap/keyboard, not only hover. */}
      <button
        type="button"
        aria-label={`Why ${p.web_name} is here`}
        className="absolute left-1 top-2 z-10 flex size-4 cursor-help items-center justify-center rounded-full bg-zinc-900/70 font-serif text-[10px] font-bold italic leading-none text-white"
      >
        i
      </button>
      <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 hidden w-44 -translate-x-1/2 rounded-lg bg-zinc-900 px-2.5 py-2 text-left text-[10px] leading-snug text-zinc-100 shadow-xl ring-1 ring-white/10 group-hover/card:block group-focus-within/card:block">
        <div className="font-semibold text-white">
          {p.web_name}{" "}
          <span className="font-normal text-zinc-400">
            {p.position ?? ""} · {p.team_short}
          </span>
        </div>
        {price != null && <div className="text-zinc-300">Price £{price}m</div>}
        <div className="text-zinc-300">Proj {p.xp_next == null ? "—" : p.xp_next.toFixed(1)} pts next GW</div>
        {p.xp_horizon != null && <div className="text-zinc-300">{p.xp_horizon.toFixed(1)} pts over the plan</div>}
        <div className="text-zinc-300">Status: {STATUS_LABEL[p.status ?? "a"] ?? "Available"}</div>
        {p.is_captain && <div className="mt-0.5 text-amber-300">Captain — points count double.</div>}
        {p.is_vice_captain && !p.is_captain && (
          <div className="mt-0.5 text-amber-300">Vice-captain — steps in if the captain doesn&apos;t play.</div>
        )}
        {p.note && <div className="mt-1 text-emerald-300">{p.note}</div>}
      </div>
    </div>
  );
}

function Row({ players }: { players: SquadPlayer[] }) {
  return (
    <div className="flex justify-center gap-2 sm:gap-4">
      {players.map((p) => (
        <PlayerCard key={p.fpl_id} p={p} />
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
}: {
  gk: SquadPlayer[];
  def: SquadPlayer[];
  mid: SquadPlayer[];
  fwd: SquadPlayer[];
  bench: SquadPlayer[];
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
          <Row players={gk} />
          <Row players={def} />
          <Row players={mid} />
          <Row players={fwd} />
        </div>
      </div>

      {/* bench */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Bench
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
          <Row players={bench} />
        </div>
      </div>
    </div>
  );
}
