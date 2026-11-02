import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { ChipStrategy, type ChipEntry } from "@/components/chip-strategy";
import { opponentLabels } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

// Chips tab: for every chip, when it's worth playing and exactly what to change if you play it in any
// gameweek of your plan. The worker computes each option (optimize.py _chip_plan -> transfers.chips).
export default async function ChipsPage() {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Chips</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          <Link href="/login" className="text-emerald-400 hover:underline">Log in</Link> to see chip guidance for your own squad.
        </p>
      </main>
    );
  }

  const { data: runs } = await supabase
    .from("optimizer_runs")
    .select("transfers, chip_reco, horizon, created_at")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const run = runs?.[0];
  const t = (run?.transfers ?? {}) as { chips?: ChipEntry[] };
  const chips = (t.chips ?? []).filter((c) => Array.isArray(c.options));
  // Each chip option's GW, so its squad cards show the opponents of that week.
  const opponentsByGw = await opponentLabels(supabase, chips.flatMap((c) => c.options.map((o) => o.gw)));

  const { data: ownRows } = await supabase.from("players").select("fpl_id, selected_by_percent");
  const ownership: Record<number, number> = Object.fromEntries(
    (ownRows ?? []).map((r) => [r.fpl_id as number, Number(r.selected_by_percent ?? 0)]),
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Chips</h1>
      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
        <li>• What each chip would change in your squad, for any gameweek in your plan</li>
        <li>• Gains are extra projected points compared with playing that week normally</li>
        <li>
          • A chip is recommended only when its gain clears its bar; in the first half, unused chips are pushed
          before they expire at GW19
        </li>
        <li>• Tap the i on any player for why he&apos;s in the chip squad</li>
      </ul>

      {run?.chip_reco ? (
        <div className="mt-5 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-violet-300">Recommendation</span>
          <ul className="mt-1 space-y-0.5 text-sm">
            {run.chip_reco
              .split(/(?<=\.)\s+|\s+—\s+|;\s+/)
              .filter((x: string) => x.trim())
              .map((x: string, i: number) => (
                <li key={i}>• {x.replace(/\.$/, "")}</li>
              ))}
          </ul>
        </div>
      ) : null}

      {chips.length ? (
        <ChipStrategy chips={chips} ownership={ownership} opponentsByGw={opponentsByGw} />
      ) : (
        <ul className="mt-6 space-y-0.5 text-sm text-muted-foreground">
          <li>• No chip guidance yet for your squad</li>
          <li>
            • Open the <Link href="/optimizer" className="text-emerald-400 hover:underline">Optimizer</Link> and run
            &quot;Optimize my squad&quot;; chip options appear here a minute or two later
          </li>
        </ul>
      )}
    </main>
  );
}
