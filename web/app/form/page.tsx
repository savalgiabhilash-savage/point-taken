import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getForm, FORM_GAMES } from "@/lib/form";
import { PageHeader } from "@/components/shell";
import { NextChips, PlayerRows, ResultChips, Tags, TeamLink } from "@/components/form-bits";

export const dynamic = "force-dynamic";

const POSITIONS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;

// Scout → Form: every club ranked by its last 6 league games (results, goals for and against, clean sheets,
// trend vs its season), then the players in form. Tap a club for its profile and hot picks.
export default async function FormPage({ searchParams }: { searchParams: Promise<{ pos?: string }> }) {
  const { pos: rawPos } = await searchParams;
  const pos = POSITIONS.find((p) => p === rawPos?.toUpperCase()) ?? "ALL";
  const { teams, players, gws } = await getForm(createSupabaseServerClient());
  const inForm = players
    .filter((p) => (pos === "ALL" || p.pos === pos) && p.mins >= 270)
    .sort((a, b) => b.form - a.form || b.xp - a.xp)
    .slice(0, 25);
  const hot = players.filter((p) => p.hot).sort((a, b) => b.xp - a.xp).slice(0, 8);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Form">
        <ul>
          <li>• Which clubs and players are in form, from the last {FORM_GAMES} league games</li>
          <li>• Tags show what a club is doing well (or badly) compared with the rest of the league</li>
          <li>• Hot picks: in form (FPL form 5+) and among the model&apos;s top projections for the next {gws} GWs</li>
          <li>• Tap a club for its profile: results, scorers, strengths, weak spots and its hot picks</li>
        </ul>
      </PageHeader>

      {hot.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Hot picks right now</h2>
          <div className="flex flex-wrap gap-2">
            {hot.map((p) => (
              <Link
                key={p.id}
                href={`/form/${p.team.toLowerCase()}`}
                className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-1.5 text-sm hover:border-orange-500/60"
              >
                <span className="font-semibold">{p.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {p.team} · form {p.form.toFixed(1)} · {p.xp.toFixed(1)} xPts
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Clubs by form (last {FORM_GAMES})</h2>
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-2 py-2 text-left font-medium">Club</th>
                <th className="px-2 py-2 text-left font-medium">Last {FORM_GAMES}</th>
                <th className="px-2 py-2 text-right font-medium" title="Points from the last 6">Pts</th>
                <th className="px-2 py-2 text-right font-medium" title="Goals scored a game, last 6">GF/g</th>
                <th className="px-2 py-2 text-right font-medium" title="Goals conceded a game, last 6">GA/g</th>
                <th className="px-2 py-2 text-right font-medium" title="Clean sheets, last 6">CS</th>
                <th className="px-2 py-2 text-left font-medium">What stands out</th>
                <th className="px-3 py-2 text-left font-medium">Next 3</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => {
                const trend = t.ppg - t.seasonPpg;
                return (
                  <tr key={t.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{t.formRank}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <TeamLink t={t} />
                      <span
                        className={`ml-1 text-xs ${trend >= 0.4 ? "text-emerald-400" : trend <= -0.4 ? "text-rose-400" : "text-muted-foreground"}`}
                        title={`${t.ppg.toFixed(1)} pts a game lately vs ${t.seasonPpg.toFixed(1)} this season`}
                      >
                        {trend >= 0.4 ? "▲" : trend <= -0.4 ? "▼" : "•"}
                      </span>
                    </td>
                    <td className="px-2 py-2"><ResultChips recent={t.recent} /></td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{t.pts}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.gf.toFixed(1)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.ga.toFixed(1)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{t.cs}</td>
                    <td className="px-2 py-2"><Tags tags={t.tags} /></td>
                    <td className="px-3 py-2"><NextChips next={t.next} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          • ▲ / ▼: picking up more / fewer points a game than across the whole season · next fixtures: capitals = home, colour = difficulty
        </p>
      </section>

      <section className="mt-8">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Players in form</h2>
          <div className="flex gap-1">
            {POSITIONS.map((p) => (
              <Link
                key={p}
                href={p === "ALL" ? "/form" : `/form?pos=${p}`}
                scroll={false}
                className={`rounded-md border px-2.5 py-1 text-xs ${p === pos ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
              >
                {p === "ALL" ? "All" : p}
              </Link>
            ))}
          </div>
        </div>
        <PlayerRows players={inForm} gws={gws} />
        <p className="mt-1.5 text-xs text-muted-foreground">• Players with 270+ minutes this season, by FPL form</p>
      </section>
    </main>
  );
}
