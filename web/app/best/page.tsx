import { createSupabaseServerClient, type Calibration, type GwPrediction } from "@/lib/supabase";
import { BestSquadTabs } from "@/components/best-squad-tabs";

export const dynamic = "force-dynamic";

const POS_ORDER = ["GK", "DEF", "MID", "FWD"];

export default async function BestPage() {
  const supabase = createSupabaseServerClient();

  const [predsRes, calibRes] = await Promise.all([
    supabase.from("gw_predictions").select("*").order("gw", { ascending: false }),
    supabase.from("model_calibration").select("position, n_gws, multiplier"),
  ]);

  // gw_predictions may not exist yet (migration 0003 not applied) — treat as empty.
  const preds = (predsRes.error ? [] : (predsRes.data ?? [])) as GwPrediction[];
  const calib = (calibRes.error ? [] : (calibRes.data ?? [])) as Calibration[];

  const upcomingGw = preds.filter((p) => !p.scored).reduce<number | null>((m, p) => (m == null || p.gw > m ? p.gw : m), null);
  const capped = preds.find((p) => p.gw === upcomingGw && p.variant === "capped") ?? null;
  const uncapped = preds.find((p) => p.gw === upcomingGw && p.variant === "uncapped") ?? null;

  // Scorecard: completed gameweeks (capped variant), newest first.
  const history = preds
    .filter((p) => p.scored && p.variant === "capped" && p.actual_pts != null && p.predicted_pts != null)
    .sort((a, b) => b.gw - a.gw);

  const calibByPos = new Map(calib.map((c) => [c.position, c]));
  const migrationMissing = predsRes.error != null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Best XI{upcomingGw != null ? ` — GW${upcomingGw}` : ""}
        </h1>
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          <li>• The highest-projected squad for the upcoming gameweek, with a £100m budget or none</li>
          <li>• Each week&apos;s pick is scored against what happened; accuracy calibrates future projections</li>
        </ul>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          <li>
            • Best team for <span className="text-foreground">this gameweek only</span>
          </li>
          <li>
            • For transfers, captaincy and chips over several weeks, use the{" "}
            <span className="text-foreground">Optimizer</span>
          </li>
        </ul>
      </div>

      {migrationMissing && (
        <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
          The predictions tables aren&apos;t set up yet — run <code>supabase/migrations/0003_predictions.sql</code> in
          Supabase, then the pipeline populates this page.
        </div>
      )}

      <div className="mt-6">
        <BestSquadTabs capped={capped} uncapped={uncapped} />
      </div>

      {/* Prediction accuracy */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Prediction accuracy
          </div>
          {history.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left">GW</th>
                    <th className="px-3 py-2 text-right">Predicted</th>
                    <th className="px-3 py-2 text-right">Actual</th>
                    <th className="px-3 py-2 text-right">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const diff = (h.actual_pts as number) - (h.predicted_pts as number);
                    return (
                      <tr key={h.gw} className="border-b border-border/40">
                        <td className="px-3 py-2 font-medium">GW{h.gw}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.predicted_pts!.toFixed(1)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{h.actual_pts!.toFixed(0)}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            diff >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {diff >= 0 ? "+" : ""}
                          {diff.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl border border-border/60 bg-card px-4 py-6 text-sm text-muted-foreground">
              No completed gameweeks yet — the predicted vs. actual scorecard appears here after GW1.
            </p>
          )}
        </section>

        <section>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model calibration
          </div>
          <div className="rounded-xl border border-border/60 bg-card p-4">
            {calib.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {POS_ORDER.map((pos) => {
                  const c = calibByPos.get(pos);
                  const m = c?.multiplier ?? 1;
                  return (
                    <li key={pos} className="flex items-center justify-between">
                      <span className="font-medium">{pos}</span>
                      <span className="tabular-nums text-muted-foreground">
                        ×
                        <span className={m > 1 ? "text-emerald-400" : m < 1 ? "text-amber-400" : "text-foreground"}>
                          {m.toFixed(3)}
                        </span>
                        {c ? <span className="ml-2 text-xs">({c.n_gws} GW{c.n_gws === 1 ? "" : "s"})</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                <li>• Projections run uncalibrated (×1.000) for now</li>
                <li>• Once gameweeks are scored, a position the model over- or under-rates gets a correction here</li>
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
