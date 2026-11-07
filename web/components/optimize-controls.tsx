"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { toast } from "@/components/toast";
import { Loader2 } from "lucide-react";

// Horizon slider (1..gameweeks left) + "Optimize my squad" button. The optimizer is a Python MILP
// that runs on GitHub Actions (it can't run in a serverless function), so this fires a cloud run for
// the user's current squad at the chosen horizon, then polls optimizer_runs until a fresh plan lands.
export function OptimizeControls({
  initialHorizon,
  maxHorizon,
  userId,
  lastComputedAt,
}: {
  initialHorizon: number;
  maxHorizon: number;
  userId: string;
  lastComputedAt: string | null;
}) {
  const router = useRouter();
  const cap = Math.max(1, Math.min(maxHorizon || 5, 38));
  const [horizon, setHorizon] = React.useState(Math.max(1, Math.min(initialHorizon || 5, cap)));
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const optimize = async () => {
    setBusy(true);
    setMsg(`Optimizing your current squad over the next ${horizon} gameweek${horizon === 1 ? "" : "s"} — runs in the cloud, ~1–2 min.`);
    toast(`Optimizing over ${horizon} GW${horizon === 1 ? "" : "s"} · ~1–2 min`, "loading", "optimize");
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ horizon }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Couldn't start the optimization.");
        toast(data.error ?? "Couldn't start the optimization", "error", "optimize");
        setBusy(false);
        return;
      }
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
          toast("New plan ready", "success", "optimize");
          router.refresh();
          setBusy(false);
        } else if (Date.now() - startedAt > 240_000) {
          clearInterval(timer);
          setMsg("Still running — reload the page in a moment to see the updated plan.");
          toast("Still running — reload in a moment for the new plan", "error", "optimize");
          setBusy(false);
        }
      }, 8_000);
    } catch {
      setMsg("Couldn't start the optimization — please retry.");
      toast("Couldn't start the optimization — please retry", "error", "optimize");
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-border/60 bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan horizon</span>
        <div className="flex flex-1 items-center gap-3">
          <input
            type="range"
            min={1}
            max={cap}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            disabled={busy}
            className="h-1.5 min-w-[140px] flex-1 cursor-pointer accent-emerald-500 disabled:opacity-40"
            aria-label="Number of upcoming gameweeks to plan over"
          />
          <span className="w-24 shrink-0 text-sm font-semibold tabular-nums">
            {horizon} GW{horizon === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={optimize}
          disabled={busy}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-emerald-500/90 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Optimizing…" : "Optimize my squad"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Choose how many upcoming gameweeks to plan over — 1 to {cap} (the gameweeks left with projections).
      </p>
      {msg ? <p className="mt-1 text-xs text-amber-500">{msg}</p> : null}
    </div>
  );
}
