import Link from "next/link";
import type { Result, TeamForm, Upcoming, FormPlayer } from "@/lib/form";
import { PlayerInfo } from "@/components/player-info";

// Small server-rendered pieces shared by Scout → Form and the team profile.

const RES: Record<Result["res"], string> = {
  W: "bg-emerald-500/20 text-emerald-300",
  D: "bg-zinc-500/25 text-zinc-300",
  L: "bg-rose-500/20 text-rose-300",
};

export function ResultChips({ recent }: { recent: Result[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {recent.map((r, i) => (
        <span
          key={i}
          title={`GW${r.gw ?? "?"} ${r.home ? "v" : "@"} ${r.opp} ${r.gf}–${r.ga}`}
          className={`inline-flex size-5 items-center justify-center rounded text-[10px] font-bold ${RES[r.res]}`}
        >
          {r.res}
        </span>
      ))}
    </span>
  );
}

export function fdrCls(fdr: number | null): string {
  if (fdr == null) return "bg-muted text-muted-foreground";
  if (fdr < 2) return "bg-emerald-500/20 text-emerald-300";
  if (fdr < 2.75) return "bg-lime-500/20 text-lime-300";
  if (fdr < 3.5) return "bg-amber-500/20 text-amber-300";
  if (fdr < 4.25) return "bg-orange-500/20 text-orange-300";
  return "bg-rose-500/20 text-rose-300";
}

export function NextChips({ next }: { next: Upcoming[] }) {
  return (
    <span className="inline-flex gap-1">
      {next.map((n, i) => (
        <span
          key={i}
          title={`GW${n.gw}${n.fdr != null ? ` · difficulty ${n.fdr.toFixed(1)}` : ""}`}
          className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${fdrCls(n.fdr)}`}
        >
          {n.home ? n.opp : n.opp.toLowerCase()}
        </span>
      ))}
    </span>
  );
}

export function Tags({ tags }: { tags: TeamForm["tags"] }) {
  const cls = { good: "bg-emerald-500/15 text-emerald-300", bad: "bg-rose-500/15 text-rose-300", neutral: "bg-muted text-muted-foreground" };
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t.label} className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls[t.tone]}`}>
          {t.label}
        </span>
      ))}
    </span>
  );
}

export function TeamLink({ t }: { t: { short: string; name: string } }) {
  return (
    <Link href={`/form/${t.short.toLowerCase()}`} className="font-semibold hover:underline">
      {t.name}
    </Link>
  );
}

/** Player rows: form, last-6 returns for his club, season xGI per 90, next-3 projection. */
export function PlayerRows({ players, gws, showTeam = true }: { players: FormPlayer[]; gws: number; showTeam?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left font-medium">Player</th>
            <th className="px-2 py-2 text-right font-medium" title="FPL form: average points a game over the last 30 days">Form</th>
            <th className="px-2 py-2 text-right font-medium" title="Goals, assists and bonus in his club's last 6 league games">G · A · B</th>
            <th className="px-2 py-2 text-right font-medium" title="Expected goal involvements per 90 minutes, season">xGI/90</th>
            <th className="px-2 py-2 text-right font-medium">Next {gws} xPts</th>
            <th className="px-3 py-2 text-right font-medium">Own</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id} className="border-b border-border/50 last:border-0">
              <td className="px-3 py-1.5">
                <span className="mr-1.5 inline-block w-8 text-[10px] font-bold text-muted-foreground">{p.pos}</span>
                <Link href={`/compare?p=${p.id}`} className="font-medium hover:text-sky-300 hover:underline">
                  {p.name}
                </Link>
                {showTeam ? <span className="ml-1 text-xs text-muted-foreground">{p.team}</span> : null}
                <span className="ml-1 text-xs text-muted-foreground">£{p.price.toFixed(1)}</span>
                {p.hot ? <span className="ml-1.5 rounded bg-orange-500/20 px-1 text-[10px] font-bold text-orange-300">HOT</span> : null}
                {p.status !== "a" ? <span className="ml-1.5 rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-300">flagged</span> : null}
                <PlayerInfo
                  playerId={p.id}
                  name={p.name}
                  why={[
                    `FPL form ${p.form.toFixed(1)} pts a game (last 30 days)`,
                    `Club's last 6: ${p.goals} goals, ${p.assists} assists, ${p.bonus} bonus`,
                    `Season xGI per 90: ${p.xgi90.toFixed(2)}`,
                    `Projected ${p.xp.toFixed(1)} pts over the next ${gws} GWs`,
                  ]}
                />
              </td>
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{p.form.toFixed(1)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {p.goals} · {p.assists} · {p.bonus}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.xgi90.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{p.xp.toFixed(1)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{p.own.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
