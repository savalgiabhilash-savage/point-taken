"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

// Horizon selector + "Optimize my squad" button. The optimizer is a Python MILP that runs on GitHub
// Actions (it can't run in a serverless function), so this fires a cloud run for the user's current
// squad at the chosen horizon, then polls optimizer_runs until a fresh plan lands and refreshes.
const OPTIONS = [3, 5, 8];

export function OptimizeControls({
  initialHorizon,
  userId,
  lastComputedAt,
}: {
  initialHorizon: number;
  userId: string;
  lastComputedAt: string | null;
}) {
  const router = useRouter();
  const [horizon, setHorizon] = React.useState(OPTIONS.includes(initialHorizon) ? initialHorizon : 5);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const optimize = async () => {
    setBusy(true);
    setMsg(`Optimizing your current squad over the next ${horizon} gameweeks — runs in the cloud, ~1–2 min.`);
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ horizon }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Couldn't start the optimization.");
        setBusy(false);
        return;
      }
      // Poll for the fresh run (RLS lets a user read their own optimizer_runs).
      const sb = createBrowserSupabase();
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        const { data: rows } = await sb
          .from("optimizer_runs")
          .select("created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(1);
        const latest = rows?.[0]?.created_at ?? null;
        if (latest && latest !== lastComputedAt) {
          clearInterval(timer);
          setMsg("Done — updating the plan…");
          router.refresh();
          setBusy(false);
        } else if (Date.now() - startedAt > 180_000) {
          clearInterval(timer);
          setMsg("Still running — reload the page in a moment to see the updated plan.");
          setBusy(false);
        }
      }, 8_000);
    } catch {
      setMsg("Couldn't start the optimization — please retry.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan horizon</span>
      <div className="flex overflow-hidden rounded-lg border border-border/60">
        {OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => setHorizon(n)}
            disabled={busy}
            className={`px-3 py-1.5 text-sm transition-colors ${
              horizon === n ? "bg-emerald-500/20 text-emerald-300" : "text-muted-foreground hover:bg-muted"
            } disabled:opacity-40`}
          >
            {n} GW
          </button>
        ))}
      </div>
      <button
        onClick={optimize}
        disabled={busy}
        className="ml-auto h-9 rounded-lg bg-emerald-500/90 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
      >
        {busy ? "Optimizing…" : "Optimize my squad"}
      </button>
      {msg ? <p className="w-full text-xs text-muted-foreground">{msg}</p> : null}
    </div>
  );
}
