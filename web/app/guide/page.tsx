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

const CHIPS: { label: string; cls: string; meaning: string }[] = [
  { label: "injury", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400", meaning: "A knock, doubt, or fitness concern — real risk of missing out." },
  { label: "susp.", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400", meaning: "Suspension news — likely unavailable." },
  { label: "rotation", cls: "bg-amber-500/15 text-amber-600 ring-amber-500/30 dark:text-amber-400", meaning: "Squad-depth / benching risk — may not start." },
  { label: "return", cls: "bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400", meaning: "Coming back from injury — minutes trending up." },
  { label: "buzz", cls: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400", meaning: "Positive form or hype around the player." },
  { label: "transfer", cls: "bg-violet-500/15 text-violet-600 ring-violet-500/30 dark:text-violet-400", meaning: "Move rumours — creates future uncertainty." },
  { label: "news", cls: "bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-400", meaning: "Other relevant news worth a glance." },
];

const FDR: { label: string; cls: string }[] = [
  { label: "very easy", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  { label: "easy", cls: "bg-lime-500/15 text-lime-700 dark:text-lime-400" },
  { label: "average", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  { label: "hard", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-400" },
  { label: "very hard", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400" },
];

const COMPONENTS: { label: string; cls: string; note: string }[] = [
  { label: "Appearance", cls: "bg-zinc-400", note: "Points just for playing (1) and for 60+ mins (1)." },
  { label: "Goals", cls: "bg-emerald-500", note: "Expected goals × the position's goal value (GK/DEF 6, MID 5, FWD 4)." },
  { label: "Assists", cls: "bg-sky-500", note: "Expected assists × 3." },
  { label: "Clean sheet", cls: "bg-teal-500", note: "P(clean sheet) × CS value, weighted by chance of 60+ mins." },
  { label: "Bonus", cls: "bg-violet-500", note: "Proxy for BPS bonus from involvement." },
  { label: "DefCon", cls: "bg-amber-500", note: "Defensive-contribution points (rough placeholder for now)." },
  { label: "Saves", cls: "bg-cyan-500", note: "Goalkeeper save points (rough)." },
  { label: "Deductions", cls: "bg-rose-500", note: "Goals conceded (GK/DEF) and card risk — subtracted." },
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
        <p className="text-sm text-muted-foreground">
          A personal Fantasy Premier League decision tool. It projects each player&apos;s expected
          points with a transparent, own-built model — every number can be broken down into its parts.
        </p>
      </div>

      <div className="mt-6 grid gap-4">
        <Card title="The tabs">
          <ul className="space-y-1.5">
            <li><b>Players</b> — every player ranked by projected points (xPts). Sort, filter, and click any row for the full breakdown.</li>
            <li><b>Fixtures</b> — a difficulty ticker: each team&apos;s next 8 gameweeks, coloured by how tough the run is (easiest runs first).</li>
            <li><b>My Team</b> — your real FPL squad as a pitch view.</li>
            <li><b>Optimizer</b> — the best transfer(s) for your squad this week, accounting for your bank, free transfers, and −4 hits.</li>
            <li><b>Guide</b> — this page.</li>
          </ul>
        </Card>

        <Card title="Reading the Players table">
          <ul className="space-y-1.5">
            <li><b>xPts</b> — projected points for the next gameweek. The headline number. Greener = higher.</li>
            <li><b>Next 5</b> — xPts summed across the next five gameweeks (good for longer-term picks).</li>
            <li><b>Opp</b> — the next opponent (a leading <span className="tabular-nums">@</span> means away), coloured by fixture difficulty.</li>
            <li><b>Price</b> — current cost. <b>Own %</b> — how many managers own them. <b>Last szn</b> — total points last season.</li>
            <li><b>Pos</b> —{" "}
              <span className="inline-flex gap-1">
                <Chip cls="bg-amber-400/15 text-amber-600 ring-amber-400/30 dark:text-amber-400">GK</Chip>
                <Chip cls="bg-emerald-400/15 text-emerald-600 ring-emerald-400/30 dark:text-emerald-400">DEF</Chip>
                <Chip cls="bg-sky-400/15 text-sky-600 ring-sky-400/30 dark:text-sky-400">MID</Chip>
                <Chip cls="bg-rose-400/15 text-rose-600 ring-rose-400/30 dark:text-rose-400">FWD</Chip>
              </span>
            </li>
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span><b>Status dot</b> (far right):</span>
              {STATUS.map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5">
                  <Dot cls={s.cls} /> {s.label}
                </span>
              ))}
            </li>
          </ul>
          <p className="text-muted-foreground">Tip: click a row to open the detail drawer with the breakdown, the next-five fixtures, and any news.</p>
        </Card>

        <Card title="The xPts breakdown">
          <p>Every projection is the sum of named parts, each scaled by the chance the player starts and how many minutes they&apos;re expected to play. Open any player to see the stacked bar and these components:</p>
          <ul className="space-y-1.5">
            {COMPONENTS.map((c) => (
              <li key={c.label} className="flex items-start gap-2">
                <span className={`mt-1 size-2.5 shrink-0 rounded-full ${c.cls}`} />
                <span><b>{c.label}</b> — {c.note}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Fixture difficulty (FDR)">
          <p>A data-driven 1–5 difficulty for each fixture, computed from last season&apos;s team attacking/defensive expected goals — not the official FPL rating. Lower is easier.</p>
          <div className="flex flex-wrap gap-2">
            {FDR.map((f) => (
              <span key={f.label} className={`inline-flex min-w-16 items-center justify-center rounded-md px-2 py-1 text-xs font-medium ${f.cls}`}>
                {f.label}
              </span>
            ))}
          </div>
        </Card>

        <Card title="News & sentiment signals">
          <p>Recent headlines for flagged and highly-owned players are classified into a single chip next to the player&apos;s name. Open the drawer for the summary and a link to the source.</p>
          <ul className="space-y-1.5">
            {CHIPS.map((c) => (
              <li key={c.label} className="flex items-center gap-2">
                <Chip cls={c.cls}>{c.label}</Chip>
                <span className="text-muted-foreground">{c.meaning}</span>
              </li>
            ))}
          </ul>
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            News is <b>advisory</b>. A &ldquo;minutes risk&rdquo; percentage may show how much the news lowers a player&apos;s
            chance of starting — but it is deliberately <b>not</b> folded into the xPts number until it&apos;s been
            validated. Treat it as a nudge, and always check the source.
          </p>
        </Card>

        <Card title="How the model works (and its limits)">
          <ul className="space-y-1.5">
            <li>Attacking output uses last season&apos;s expected goals/assists, <b>shrunk toward the position average</b> so small hot streaks don&apos;t overstate a player (a Haaland stays top; a one-game wonder regresses).</li>
            <li>Everything scales by <b>minutes</b> — a great fixture is worth little if the player won&apos;t start.</li>
            <li>Clean sheets come from expected goals conceded (opponent attack vs. team defence, home/away adjusted).</li>
            <li><b>Honest caveats:</b> defensive-contribution, saves, and bonus are rough placeholders for now, and preseason projections lean on last season&apos;s baseline until live form accumulates.</li>
          </ul>
        </Card>

        <Card title="How fresh is the data?">
          <p>The full pipeline (FPL data, advanced stats, projections, your team, optimizer, and news) refreshes automatically twice a day. You&apos;re always looking at recent numbers, not a stale snapshot.</p>
        </Card>
      </div>
    </main>
  );
}
