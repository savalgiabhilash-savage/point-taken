import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getForm, FORM_GAMES } from "@/lib/form";
import { PageHeader } from "@/components/shell";
import { NextChips, PlayerRows, ResultChips, Tags } from "@/components/form-bits";

export const dynamic = "force-dynamic";

// A club's form profile: headline numbers vs the league, what it's doing well and badly, every recent result
// with its scorers, upcoming fixtures, and its hot picks.
export default async function TeamFormPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const { teams, players, gws } = await getForm(createSupabaseServerClient());
  const t = teams.find((x) => x.short.toLowerCase() === team.toLowerCase());
  if (!t) notFound();

  const squad = players.filter((p) => p.teamId === t.id);
  const picks = squad.filter((p) => p.status === "a").sort((a, b) => b.xp - a.xp).slice(0, 5);
  const inForm = squad.filter((p) => p.mins >= 90).sort((a, b) => b.form - a.form).slice(0, 8);
  const stats = [
    { label: "Form rank", value: `${t.formRank} / 20`, sub: `${t.pts} pts from ${t.recent.length}` },
    { label: "Attack", value: `${t.gf.toFixed(1)} a game`, sub: `#${t.attackRank} lately · season ${t.seasonGf.toFixed(1)}` },
    { label: "Defence", value: `${t.ga.toFixed(1)} conceded`, sub: `#${t.defenceRank} lately · season ${t.seasonGa.toFixed(1)}` },
    { label: "Clean sheets", value: `${t.cs} of ${t.recent.length}`, sub: `${t.ppg.toFixed(1)} pts a game (season ${t.seasonPpg.toFixed(1)})` },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title={t.name}>
        <ul>
          <li>• Form over the last {FORM_GAMES} league games, ranked against the other 19 clubs</li>
          <li>
            • <Link href="/form" className="text-brand hover:underline">All clubs</Link>
          </li>
        </ul>
      </PageHeader>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <ResultChips recent={t.recent} />
        <Tags tags={t.tags} />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-lg font-semibold">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-emerald-300">Doing well</h2>
          <ul className="mt-1 space-y-0.5 text-sm">
            {t.strengths.length ? t.strengths.map((s) => <li key={s}>• {s}</li>) : <li>• Nothing stands out</li>}
          </ul>
        </section>
        <section className="rounded-2xl border border-rose-500/25 bg-rose-500/5 px-4 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-rose-300">Weak spots</h2>
          <ul className="mt-1 space-y-0.5 text-sm">
            {t.weaknesses.length ? t.weaknesses.map((s) => <li key={s}>• {s}</li>) : <li>• None over this run</li>}
          </ul>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Hot picks (next {gws} GWs)</h2>
        <PlayerRows players={picks} gws={gws} showTeam={false} />
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Next fixtures:</span> <NextChips next={t.next} />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent results</h2>
        <ul className="space-y-1.5">
          {[...t.recent].reverse().map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-sm">
              <span className="w-10 text-xs text-muted-foreground">GW{r.gw ?? "?"}</span>
              <ResultChips recent={[r]} />
              <span className="font-semibold tabular-nums">
                {r.gf}–{r.ga}
              </span>
              <span>
                {r.home ? "v" : "@"} {r.opp}
              </span>
              {r.scorers.length ? <span className="text-xs text-muted-foreground">⚽ {r.scorers.join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Players in form</h2>
        <PlayerRows players={inForm} gws={gws} showTeam={false} />
      </section>
    </main>
  );
}
