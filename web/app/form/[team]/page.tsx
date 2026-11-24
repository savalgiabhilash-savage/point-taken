import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getForm, FORM_GAMES } from "@/lib/form";
import { loadCompare } from "@/lib/compare";
import { PageHeader } from "@/components/shell";
import { NextChips, PlayerRows, ResultChips, Tags } from "@/components/form-bits";
import { CardTile, Crest, RankBar } from "@/components/form-cards";

export const dynamic = "force-dynamic";

const KEY_PLAYERS = 6;

// A club's form profile: crest and form at a glance, stats ranked against the league, its key players as
// Compare cards (tap one to compare), what it's doing well and badly, results with scorers, and fixtures.
export default async function TeamFormPage({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const [{ teams, players, gws }, { players: cards }] = await Promise.all([
    getForm(createSupabaseServerClient()),
    loadCompare(),
  ]);
  const t = teams.find((x) => x.short.toLowerCase() === team.toLowerCase());
  if (!t) notFound();

  const formOf = new Map(players.map((p) => [p.id, p]));
  const squad = players.filter((p) => p.teamId === t.id);
  const key = cards
    .filter((c) => formOf.get(c.id)?.teamId === t.id && c.status !== "u")
    .sort((a, b) => b.ovr - a.ovr || b.form - a.form)
    .slice(0, KEY_PLAYERS);
  const inForm = squad.filter((p) => p.mins >= 90).sort((a, b) => b.form - a.form).slice(0, 10);
  const stats = [
    { label: "Form", value: `${t.pts} pts`, sub: `from the last ${t.recent.length} · ${t.formRank}${ordSuffix(t.formRank)} of 20`, rank: t.formRank },
    { label: "Attack", value: `${t.gf.toFixed(1)} a game`, sub: `${t.attackRank}${ordSuffix(t.attackRank)} of 20 · season ${t.seasonGf.toFixed(1)}`, rank: t.attackRank },
    { label: "Defence", value: `${t.ga.toFixed(1)} conceded`, sub: `${t.defenceRank}${ordSuffix(t.defenceRank)} of 20 · season ${t.seasonGa.toFixed(1)}`, rank: t.defenceRank },
    { label: "Clean sheets", value: `${t.cs} of ${t.recent.length}`, sub: `${t.ppg.toFixed(1)} pts a game (season ${t.seasonPpg.toFixed(1)})`, rank: null },
  ];
  const trend = t.ppg - t.seasonPpg;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title={t.name}>
        <ul>
          <li>• Form over the last {FORM_GAMES} league games, ranked against the other 19 clubs</li>
          <li>• Tap a player card to compare him with a like-for-like rival</li>
          <li>
            • <Link href="/form" className="text-brand hover:underline">← All clubs</Link>
          </li>
        </ul>
      </PageHeader>

      {/* at a glance */}
      <section className="mt-5 flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card px-4 py-4">
        <Crest t={t} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-display text-3xl leading-none">#{t.formRank}</span>
            <span className="text-sm text-muted-foreground">on form</span>
            <span className={`text-sm font-semibold ${trend >= 0.4 ? "text-emerald-400" : trend <= -0.4 ? "text-rose-400" : "text-muted-foreground"}`}>
              {trend >= 0.4 ? "▲ improving" : trend <= -0.4 ? "▼ slumping" : "• steady"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ResultChips recent={t.recent} />
            <Tags tags={t.tags} />
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          <div className="mb-1 uppercase tracking-wide">Next {gws}</div>
          <NextChips next={t.next} />
        </div>
      </section>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-lg font-semibold">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.sub}</div>
            {s.rank ? <RankBar rank={s.rank} /> : null}
          </div>
        ))}
      </div>

      {key.length ? (
        <section className="mt-7">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Key players</h2>
          <div className="grid grid-cols-2 justify-items-center gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            {key.map((c) => (
              <CardTile key={c.id} p={c} f={formOf.get(c.id)} wide />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">• Ranked by card rating (next-5-GW projection); G A B = goals, assists, bonus in the club&apos;s last {FORM_GAMES}</p>
        </section>
      ) : null}

      <div className="mt-7 grid gap-3 sm:grid-cols-2">
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

      <section className="mt-7">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent results</h2>
        <ol className="relative space-y-2 border-l border-border pl-4">
          {[...t.recent].reverse().map((r, i) => (
            <li key={i} className="relative">
              <span
                aria-hidden
                className={`absolute -left-[21px] top-2.5 size-2.5 rounded-full ${r.res === "W" ? "bg-emerald-400" : r.res === "L" ? "bg-rose-400" : "bg-zinc-400"}`}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-card px-3 py-2 text-sm">
                <span className="w-10 text-xs text-muted-foreground">GW{r.gw ?? "?"}</span>
                <span className="font-display text-lg tabular-nums">
                  {r.gf}–{r.ga}
                </span>
                <span className="text-muted-foreground">{r.home ? "v" : "@"}</span>
                <span className="font-semibold">{r.opp}</span>
                {r.scorers.length ? <span className="w-full text-xs text-muted-foreground sm:w-auto">⚽ {r.scorers.join(", ")}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-7">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Everyone in form</h2>
        <PlayerRows players={inForm} gws={gws} showTeam={false} />
      </section>
    </main>
  );
}

function ordSuffix(n: number): string {
  return n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
}
