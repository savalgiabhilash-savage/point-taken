import { createSupabaseServerClient } from "@/lib/supabase";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Weekly post-mortem: the app's pre-deadline predictions (prediction_log, worker predict.py) scored against
// the points players actually scored (actual points are the only benchmark), against the best possible top-20
// that week, plus data-health checks so a silent pipeline failure shows up here.

type LogRow = { gw: number; position: string; predicted_xp: number; actual_pts: number | null };
type GwPred = { gw: number; variant: string; predicted_pts: number | null; actual_pts: number | null; scored: boolean };

const TOP = 20;
const CALIB_FROM_GW = 6; // GW1-5 logs predate the minutes fix / weren't kept (worker predict.CALIB_FROM_GW)

function rank(xs: number[]): number[] {
  // average ranks for ties
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

type Score = { rmse: number; rho: number; top: number; bias: number };
function score(pred: number[], actual: number[]): Score {
  const n = pred.length;
  const rmse = Math.sqrt(pred.reduce((s, p, i) => s + (p - actual[i]) ** 2, 0) / n);
  const bias = pred.reduce((s, p, i) => s + (p - actual[i]), 0) / n;
  const order = pred.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]).slice(0, TOP);
  const top = order.reduce((s, [, i]) => s + actual[i], 0) / order.length;
  return { rmse, rho: corr(rank(pred), rank(actual)), top, bias };
}

const ago = (iso: string | null | undefined): number | null =>
  iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : null;
const fmtAgo = (h: number | null) =>
  h == null ? "never" : h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${h.toFixed(1)} h ago` : `${(h / 24).toFixed(1)} days ago`;

export default async function AccuracyPage() {
  const sb = createSupabaseServerClient();
  const authed = await createServerSupabase(); // your own plan is private (RLS), so read it as you
  const { data: auth } = await authed.auth.getUser();

  const rows: LogRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("prediction_log")
      .select("gw, position, predicted_xp, actual_pts")
      .eq("scored", true)
      .range(from, from + 999);
    if (error || !data) break;
    rows.push(...(data as LogRow[]));
    if (data.length < 1000) break;
  }
  const [bestRes, lastLog, lastPlan, lastParams, lineups, news] = await Promise.all([
    sb.from("gw_predictions").select("gw, variant, predicted_pts, actual_pts, scored").order("gw"),
    sb.from("prediction_log").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    authed.from("optimizer_runs").select("created_at").order("created_at", { ascending: false }).limit(1),
    sb.from("model_params").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    sb.from("predicted_lineups").select("gw").order("gw", { ascending: false }).limit(1),
    sb.from("news_sentiment").select("id", { count: "exact", head: true }),
  ]);
  const best = (bestRes.data ?? []) as GwPred[];

  const gws = [...new Set(rows.map((r) => r.gw))].sort((a, b) => b - a);
  const perGw = gws.map((gw) => {
    const g = rows.filter((r) => r.gw === gw && r.actual_pts != null);
    const ours = score(g.map((r) => r.predicted_xp), g.map((r) => r.actual_pts as number));
    // The ceiling: the 20 highest actual scorers among the same players.
    const best20 = g.map((r) => r.actual_pts as number).sort((a, b) => b - a).slice(0, TOP);
    const ceiling = best20.reduce((x, y) => x + y, 0) / (best20.length || 1);
    const capped = best.find((b) => b.gw === gw && b.variant === "capped" && b.scored);
    return { gw, n: g.length, ours, ceiling, capped };
  });

  const byPos = ["GK", "DEF", "MID", "FWD"].map((pos) => {
    const g = rows.filter((r) => r.position === pos && r.actual_pts != null && r.gw >= CALIB_FROM_GW);
    const pred = g.reduce((s, r) => s + r.predicted_xp, 0) / (g.length || 1);
    const act = g.reduce((s, r) => s + (r.actual_pts as number), 0) / (g.length || 1);
    return { pos, n: g.length, pred, act };
  });

  // Data health: when each job last wrote, with a warning when it's stale or empty.
  const health = [
    { name: "Pipeline (projections + prediction snapshot)", hours: ago(lastLog.data?.[0]?.updated_at), warnAfter: 5 },
    ...(auth.user ? [{ name: "Your optimizer plan", hours: ago(lastPlan.data?.[0]?.created_at), warnAfter: 5 }] : []),
    { name: "Model learning (weekly re-tune / learned weights)", hours: ago(lastParams.data?.[0]?.updated_at), warnAfter: 24 * 8 },
  ];
  const newsCount = news.count ?? 0;
  const f2 = (x: number) => x.toFixed(2);
  const f3 = (x: number) => x.toFixed(3);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Accuracy</h1>
      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
        <li>• Each gameweek, the app&apos;s last pre-deadline predictions against the points players actually scored</li>
        <li>• Actual points are the only benchmark: the best possible top-20 shows the ceiling each week</li>
        <li>• Lower RMSE is better; rank correlation (ρ) and top-20 points are higher-is-better</li>
      </ul>

      <section className="mt-6 rounded-xl border border-border/60 bg-card p-4 shadow-sm">
        <h2 className="text-base font-semibold">Data health</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {health.map((h) => {
            const bad = h.hours == null || h.hours > h.warnAfter;
            return (
              <li key={h.name} className={bad ? "text-amber-500" : ""}>
                • {h.name}: {fmtAgo(h.hours)}
                {bad ? " (stale: check GitHub Actions)" : ""}
              </li>
            );
          })}
          <li className={newsCount === 0 ? "text-amber-500" : ""}>
            • News items stored: {newsCount}
            {newsCount === 0 ? " (empty: check Anthropic credits and the fpl-news workflow)" : ""}
          </li>
          <li>• Predicted line-ups: latest for GW{lineups.data?.[0]?.gw ?? "—"}</li>
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold">By gameweek</h2>
        {perGw.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No scored gameweeks yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">GW</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Players</th>
                  <th className="py-1.5 pr-3 text-right font-medium">RMSE</th>
                  <th className="py-1.5 pr-3 text-right font-medium">ρ</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Top-20 pts</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Best possible top-20</th>
                  <th className="py-1.5 text-right font-medium">Best XI pred → actual</th>
                </tr>
              </thead>
              <tbody>
                {perGw.map((r) => (
                  <tr key={r.gw} className="border-t border-border/40">
                    <td className="py-1.5 pr-3">
                      GW{r.gw}
                      {r.gw < CALIB_FROM_GW && <span className="ml-1 text-xs text-muted-foreground">(old minutes bug)</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.n}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{f2(r.ours.rmse)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{f3(r.ours.rho)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{f2(r.ours.top)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{f2(r.ceiling)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {r.capped ? `${(r.capped.predicted_pts ?? 0).toFixed(1)} → ${r.capped.actual_pts ?? "—"}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <li>• Everything is measured against actual points: RMSE is the average miss, top-20 is what our 20 highest projections actually scored</li>
          <li>• Best possible top-20 = the 20 highest actual scorers that week, the ceiling no prediction can beat</li>
          <li>• Best XI = the £100m squad the app would have picked from all players, scored with its captain</li>
          <li>• GW2–5 weren&apos;t logged (the per-player log was rebuilt in September and restarted at GW6)</li>
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-semibold">By position (scored gameweeks from GW{CALIB_FROM_GW})</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {byPos.map((p) => (
            <li key={p.pos}>
              • {p.pos}: predicted {f2(p.pred)}, actual {f2(p.act)} per player-match ({p.pred - p.act >= 0 ? "+" : ""}
              {f2(p.pred - p.act)}), {p.n} cases
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
