"use client";

import * as React from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { PRICES } from "@/lib/ai-usage";

// Settings → AI usage: this account's Claude usage (Assistant answers, screenshot team reads) for a chosen
// period, with the estimated cost. Rows come from ai_usage (RLS: each user sees only their own).

const PERIODS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
] as const;
type Period = (typeof PERIODS)[number]["key"];

const FEATURE: Record<string, string> = { assistant: "Assistant answers", team_upload: "Screenshot team reads" };

type Row = { feature: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; cost_usd: number };
type Agg = { feature: string; uses: number; calls: number; tin: number; tout: number; cost: number };

function since(p: Period): string | null {
  const now = new Date();
  if (p === "7d") return new Date(now.getTime() - 7 * 864e5).toISOString();
  if (p === "30d") return new Date(now.getTime() - 30 * 864e5).toISOString();
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return null;
}
const usd = (v: number) => (v > 0 && v < 0.01 ? "< $0.01" : `$${v.toFixed(2)}`);
const k = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));

export function AiUsage({ userId }: { userId: string }) {
  const [period, setPeriod] = React.useState<Period>("30d");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { if (alive) { setRows(null); setErr(null); } }, 0);
    let q = createBrowserSupabase()
      .from("ai_usage")
      .select("feature, model, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5000);
    const from = since(period);
    if (from) q = q.gte("created_at", from);
    q.then(({ data, error }) => {
      if (!alive) return;
      if (error) setErr("Usage tracking isn't switched on yet (migration 0015).");
      else setRows((data ?? []) as Row[]);
    });
    return () => { alive = false; clearTimeout(t); };
  }, [period, userId]);

  const agg: Agg[] = React.useMemo(() => {
    const m = new Map<string, Agg>();
    for (const r of rows ?? []) {
      const a = m.get(r.feature) ?? { feature: r.feature, uses: 0, calls: 0, tin: 0, tout: 0, cost: 0 };
      a.uses += 1;
      a.calls += Number(r.calls ?? 1);
      a.tin += Number(r.input_tokens) + Number(r.cache_write_tokens) + Number(r.cache_read_tokens);
      a.tout += Number(r.output_tokens);
      a.cost += Number(r.cost_usd);
      m.set(r.feature, a);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }, [rows]);
  const total = agg.reduce((s, a) => s + a.cost, 0);

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-5">
      <h2 className="font-display text-lg">AI usage</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">• Claude calls made for your account, with an estimated cost</p>

      <div role="radiogroup" aria-label="Period" className="mt-3 grid grid-cols-4 gap-1 rounded-lg border border-border bg-background/40 p-1">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={period === p.key}
            onClick={() => setPeriod(p.key)}
            className={`press h-9 rounded-md text-xs font-semibold sm:text-sm ${period === p.key ? "bg-grad glow" : "text-muted-foreground hover:text-foreground"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {err ? (
        <p className="mt-4 text-sm text-amber-500">• {err}</p>
      ) : rows == null ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">• Loading…</p>
      ) : (
        <>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Estimated cost</span>
            <span className="font-display text-3xl tabular-nums">{usd(total)}</span>
          </div>
          {agg.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">• No AI use in this period</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 font-semibold">Feature</th>
                  <th className="py-2 pr-2 text-right font-semibold">Uses</th>
                  <th className="py-2 pr-2 text-right font-semibold">Tokens in / out</th>
                  <th className="py-2 text-right font-semibold">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {agg.map((a) => (
                  <tr key={a.feature} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-2">{FEATURE[a.feature] ?? a.feature}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{a.uses}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{k(a.tin)} / {k(a.tout)}</td>
                    <td className="py-2 text-right tabular-nums">{usd(a.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
        <li>• Estimate = tokens × Anthropic list prices: Claude Haiku 4.5 ${PRICES["claude-haiku-4-5"].input} per 1M input, ${PRICES["claude-haiku-4-5"].output} per 1M output; Anthropic&apos;s bill is the final figure</li>
        <li>• Logged from when usage tracking was switched on; one Assistant answer can take several calls</li>
        <li>• News and line-up checks run once for everyone, so they aren&apos;t counted per account</li>
      </ul>
    </section>
  );
}
