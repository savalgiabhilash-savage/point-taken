import Link from "next/link";
import type { ComparePlayer } from "@/lib/compare";
import type { FormPlayer, TeamForm } from "@/lib/form";
import { FutCard } from "@/components/fut-card";

// Scout -> Form: player cards (the Compare card) that open Compare for that player, and club crests.

export function Crest({ t, size = 28 }: { t: Pick<TeamForm, "crest" | "short">; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Premier League crest, small, decorative
    <img src={t.crest} alt="" width={size} height={size} loading="lazy" className="inline-block shrink-0 object-contain" style={{ width: size, height: size }} />
  );
}

/** A card plus its form line; tapping opens Compare with this player (Compare adds a like-for-like rival). */
export function CardTile({ p, f, wide = false }: { p: ComparePlayer; f?: FormPlayer; wide?: boolean }) {
  return (
    <Link
      href={`/compare?p=${p.id}`}
      className={`group flex shrink-0 snap-start flex-col items-center gap-1.5 ${wide ? "w-full" : "w-[148px] sm:w-[168px]"}`}
      aria-label={`Compare ${p.name}`}
    >
      <div className="w-full transition-transform duration-200 group-hover:-translate-y-1 group-focus-visible:-translate-y-1">
        <FutCard p={p} />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-[11px] leading-tight text-muted-foreground">
        {f?.hot ? <span className="rounded bg-orange-500/20 px-1 font-bold text-orange-300">HOT</span> : null}
        <span>form {p.form.toFixed(1)}</span>
        {f ? (
          <span>
            · {f.goals}G {f.assists}A {f.bonus}B
          </span>
        ) : null}
      </div>
      <div className="text-[11px] font-semibold tabular-nums">
        {f ? `${f.xp.toFixed(1)} xPts next 3` : `${p.xp5.toFixed(1)} xPts next 5`}
        <span className="ml-1 font-normal text-sky-300 opacity-0 transition-opacity group-hover:opacity-100">Compare →</span>
      </div>
    </Link>
  );
}

/** A 1–20 league-rank bar (1 = best, full bar). */
export function RankBar({ rank }: { rank: number }) {
  const pct = ((21 - rank) / 20) * 100;
  const cls = rank <= 6 ? "bg-emerald-400" : rank >= 15 ? "bg-rose-400" : "bg-sky-400";
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/60" aria-hidden>
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
