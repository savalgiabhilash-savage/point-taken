// Static in-app guide: how to use the tool and what every number, colour, and chip means.
// Kept in sync by hand with the real signals in players-table.tsx / fixtures / the model.

export const metadata = { title: "Guide · FPL Selector" };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

// A small colour swatch + label, reusing the exact classes from the live UI.
function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}
function Dot({ cls }: { cls: string }) {
  return <span className={`inline-block size-2.5 rounded-full ${cls}`} />;
}
const B = ({ children }: { children: React.ReactNode }) => <li>• {children}</li>;

const CHIPS: { label: string; cls: string; meaning: string }[] = [
  { label: "injury", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400", meaning: "A knock, doubt, or fitness concern: real risk of missing out" },
  { label: "susp.", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400", meaning: "Suspension news: likely unavailable" },
  { label: "rotation", cls: "bg-amber-500/15 text-amber-600 ring-amber-500/30 dark:text-amber-400", meaning: "Squad-depth or benching risk: may not start" },
  { label: "return", cls: "bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400", meaning: "Coming back from injury: minutes trending up" },
  { label: "buzz", cls: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400", meaning: "Positive form or hype around the player" },
  { label: "transfer", cls: "bg-violet-500/15 text-violet-600 ring-violet-500/30 dark:text-violet-400", meaning: "Move rumours: creates uncertainty" },
  { label: "news", cls: "bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-400", meaning: "Other relevant news worth a glance" },
];

const FDR: { label: string; cls: string }[] = [
  { label: "very easy", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  { label: "easy", cls: "bg-lime-500/15 text-lime-700 dark:text-lime-400" },
  { label: "average", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  { label: "hard", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-400" },
  { label: "very hard", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400" },
];

const COMPONENTS: { label: string; cls: string; note: string }[] = [
  { label: "Appearance", cls: "bg-zinc-400", note: "Points for playing (1) and for 60+ minutes (1)" },
  { label: "Goals", cls: "bg-emerald-500", note: "Expected goals × the position's goal value (GK/DEF 6, MID 5, FWD 4)" },
  { label: "Assists", cls: "bg-sky-500", note: "Expected assists × 3" },
  { label: "Clean sheet", cls: "bg-teal-500", note: "Chance of a clean sheet × CS value, weighted by chance of 60+ minutes" },
  { label: "Bonus", cls: "bg-violet-500", note: "Estimate from goal and assist involvement (rough)" },
  { label: "DefCon", cls: "bg-amber-500", note: "Chance of reaching the defensive-contribution threshold × 2, from his own rate" },
  { label: "Saves", cls: "bg-cyan-500", note: "Goalkeeper save points from the opponent's expected goals" },
  { label: "Deductions", cls: "bg-rose-500", note: "Goals conceded (GK/DEF) and card risk, subtracted" },
];

const STATUS: { cls: string; label: string }[] = [
  { cls: "bg-emerald-500", label: "Available" },
  { cls: "bg-amber-500", label: "Doubtful" },
  { cls: "bg-red-500", label: "Injured / Suspended" },
  { cls: "bg-zinc-400", label: "Unavailable / not in squad" },
];

export default function GuidePage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">How to use this app</h1>
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          <B>A personal FPL assistant for picks, transfers, captaincy and chips</B>
          <B>Every projected number breaks down into named parts; tap the i on any player to see why</B>
        </ul>
      </div>

      <div className="mt-6 grid gap-4">
        <Card title="The tabs">
          <ul className="space-y-1.5">
            <B><b>Players</b>: every player ranked by projected points; click a row for the breakdown</B>
            <B><b>Fixtures</b>: each team&apos;s next 8 gameweeks, coloured by difficulty</B>
            <B><b>My Team</b>: your squad on a pitch; upload a screenshot to plan with unsynced transfers</B>
            <B><b>Optimizer</b>: a multi-week transfer plan (when to move, roll or take a −4) and chip timing</B>
            <B><b>Chips</b>: for each chip, the best week and the exact moves if you play it in any week</B>
            <B><b>Differentials</b>: low-owned players the model rates highly, with the reasons</B>
            <B><b>Best XI</b>: the best squad for this gameweek, scored afterwards to measure accuracy</B>
            <B><b>Assistant</b>: ask about captains, transfers, hits and chips; it only cites real numbers</B>
          </ul>
        </Card>

        <Card title="The i button">
          <ul className="space-y-1.5">
            <B>On every recommended player: pitch cards, transfers, chip squads, differentials, the Players table</B>
            <B>&ldquo;Why this pick&rdquo;: the reason for that spot (captain, transfer in, chip squad…)</B>
            <B>Then the model&apos;s factors: minutes and availability, news, form, fixture, points breakdown, price and ownership</B>
            <B>A purple <b>D</b> badge marks a differential (under 10% owned)</B>
          </ul>
        </Card>

        <Card title="Reading the Players table">
          <ul className="space-y-1.5">
            <B><b>xPts</b>: projected points next gameweek; greener is higher</B>
            <B><b>Next 5</b>: projected points over the next five gameweeks</B>
            <B><b>Opp</b>: next opponent (@ = away), coloured by difficulty</B>
            <B><b>Price</b>, <b>Own %</b> (managers who own him), <b>Last szn</b> (last season&apos;s points)</B>
            <li className="flex flex-wrap items-center gap-1">
              • <b>Pos</b>:
              <Chip cls="bg-amber-400/15 text-amber-600 ring-amber-400/30 dark:text-amber-400">GK</Chip>
              <Chip cls="bg-emerald-400/15 text-emerald-600 ring-emerald-400/30 dark:text-emerald-400">DEF</Chip>
              <Chip cls="bg-sky-400/15 text-sky-600 ring-sky-400/30 dark:text-sky-400">MID</Chip>
              <Chip cls="bg-rose-400/15 text-rose-600 ring-rose-400/30 dark:text-rose-400">FWD</Chip>
            </li>
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                • <b>Status dot</b>:
              </span>
              {STATUS.map((st) => (
                <span key={st.label} className="inline-flex items-center gap-1.5">
                  <Dot cls={st.cls} /> {st.label}
                </span>
              ))}
            </li>
          </ul>
        </Card>

        <Card title="The xPts breakdown">
          <ul className="space-y-1.5">
            <B>Each projection is the sum of the parts below</B>
            <B>Each part is scaled by the chance he starts and his expected minutes</B>
            {COMPONENTS.map((c) => (
              <li key={c.label} className="flex items-start gap-2">
                <span className={`mt-1 size-2.5 shrink-0 rounded-full ${c.cls}`} />
                <span>
                  <b>{c.label}</b>: {c.note}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Fixture difficulty (FDR)">
          <ul className="space-y-1.5">
            <B>A 1–5 difficulty from team expected goals (last season and this season), not FPL&apos;s rating</B>
            <B>Lower is easier; the projections themselves use each fixture&apos;s expected goals directly</B>
          </ul>
          <div className="flex flex-wrap gap-2">
            {FDR.map((f) => (
              <span key={f.label} className={`inline-flex min-w-16 items-center justify-center rounded-md px-2 py-1 text-xs font-medium ${f.cls}`}>
                {f.label}
              </span>
            ))}
          </div>
        </Card>

        <Card title="News signals">
          <ul className="space-y-1.5">
            <B>Headlines for flagged and popular players are read by Claude twice a day</B>
            <B>Injury, suspension, rotation, transfer and off-pitch news lowers a player&apos;s chance of starting</B>
            <B>Fresh news counts fully; it fades out over two weeks as FPL&apos;s own flag catches up</B>
            <B>If FPL&apos;s flag is already lower, the news isn&apos;t counted twice</B>
            <B>How much news counts is re-learned every gameweek from who actually started</B>
            {CHIPS.map((c) => (
              <li key={c.label} className="flex items-center gap-2">
                <Chip cls={c.cls}>{c.label}</Chip>
                <span className="text-muted-foreground">{c.meaning}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="How the model works">
          <ul className="space-y-1.5">
            <B><b>Minutes first</b>: his last 8 gameweeks, recent ones weighted most, plus injury flags and news</B>
            <B><b>Form</b>: expected goals and assists this season, with last season at half weight, pulled toward the position average</B>
            <B><b>Fixtures</b>: each team&apos;s expected goals for and against, from recent team form blended with bookmaker odds</B>
            <B><b>Accuracy</b>: every change is tested on three past seasons before it ships</B>
            <B><b>Limits</b>: bonus is a rough estimate; set pieces and fixture congestion are being added</B>
          </ul>
        </Card>

        <Card title="How fresh is the data?">
          <ul className="space-y-1.5">
            <B>Prices, injuries, projections, your team and the optimizer refresh every 2 hours</B>
            <B>News is refreshed twice a day</B>
          </ul>
        </Card>
      </div>
    </main>
  );
}
