import { createSupabaseServerClient } from "@/lib/supabase";
import { PageHeader } from "@/components/shell";

export const dynamic = "force-dynamic";

const HORIZON = 8;

function fdrClasses(fdr: number | null): string {
  if (fdr == null) return "bg-muted text-muted-foreground";
  if (fdr < 2) return "bg-emerald-500/20 text-emerald-300";
  if (fdr < 2.75) return "bg-lime-500/20 text-lime-300";
  if (fdr < 3.5) return "bg-amber-500/20 text-amber-300";
  if (fdr < 4.25) return "bg-orange-500/20 text-orange-300";
  return "bg-rose-500/25 text-rose-300";
}

type Cell = { opp: string; fdr: number | null };

export default async function FixturesPage() {
  const supabase = createSupabaseServerClient();
  const [teamsRes, fxRes] = await Promise.all([
    supabase.from("teams").select("fpl_id, name, short_name"),
    supabase
      .from("fixtures")
      .select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, finished")
      .eq("finished", false),
  ]);

  const teams = teamsRes.data ?? [];
  const fixtures = (fxRes.data ?? []).filter((f) => f.gw != null);
  const gws = [...new Set(fixtures.map((f) => f.gw as number))].sort((a, b) => a - b).slice(0, HORIZON);
  const shortById = new Map(teams.map((t) => [t.fpl_id, t.short_name]));

  const byTeam = new Map<number, Map<number, Cell[]>>();
  const add = (teamId: number, gw: number, cell: Cell) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, new Map());
    const m = byTeam.get(teamId)!;
    m.set(gw, [...(m.get(gw) ?? []), cell]);
  };
  for (const f of fixtures) {
    if (!gws.includes(f.gw as number)) continue;
    add(f.team_h, f.gw as number, { opp: `v ${shortById.get(f.team_a) ?? "?"} (H)`, fdr: f.custom_fdr_h });
    add(f.team_a, f.gw as number, { opp: `v ${shortById.get(f.team_h) ?? "?"} (A)`, fdr: f.custom_fdr_a });
  }

  const rows = teams
    .map((t) => {
      const cells = gws.map((gw) => byTeam.get(t.fpl_id)?.get(gw) ?? []);
      const fdrs = cells.flat().map((c) => c.fdr).filter((x): x is number => x != null);
      const avg = fdrs.length ? fdrs.reduce((a, b) => a + b, 0) / fdrs.length : 99;
      return { team: t, cells, avg };
    })
    .sort((a, b) => a.avg - b.avg);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Fixture Ticker">
        <ul>
          <li>• Next {gws.length} gameweeks, coloured by difficulty (green = easy, red = hard)</li>
          <li>• Teams with the easiest run are at the top</li>
        </ul>
      </PageHeader>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/40">
              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Team
              </th>
              {gws.map((gw) => (
                <th key={gw} className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  GW{gw}
                </th>
              ))}
              <th className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Avg
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ team, cells, avg }) => (
              <tr key={team.fpl_id} className="border-b border-border/40">
                <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium">{team.short_name}</td>
                {cells.map((cell, i) => (
                  <td key={i} className="px-1.5 py-1.5">
                    <div className="flex flex-col gap-1">
                      {cell.length === 0 ? (
                        <span className="block rounded px-1 py-1 text-center text-[11px] text-muted-foreground">—</span>
                      ) : (
                        cell.map((c, j) => (
                          <span
                            key={j}
                            className={`block whitespace-nowrap rounded px-1 py-1 text-center text-[11px] font-medium ${fdrClasses(c.fdr)}`}
                            title={c.fdr != null ? `FDR ${c.fdr.toFixed(1)}` : undefined}
                          >
                            {c.opp}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                ))}
                <td className="px-2 py-1.5 text-center text-xs tabular-nums text-muted-foreground">
                  {avg < 90 ? avg.toFixed(1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
