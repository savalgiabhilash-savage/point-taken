"use client";

import * as React from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { TeamUpload } from "@/components/team-upload";

export default function SettingsPage() {
  const [ready, setReady] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [entryId, setEntryId] = React.useState("");
  const [saved, setSaved] = React.useState<number | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const sb = createBrowserSupabase();
    sb.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id ?? null;
      setUserId(uid);
      if (uid) {
        const { data: p } = await sb.from("profiles").select("fpl_entry_id").eq("id", uid).maybeSingle();
        if (p?.fpl_entry_id) {
          setEntryId(String(p.fpl_entry_id));
          setSaved(p.fpl_entry_id);
        }
      }
      setReady(true);
    });
  }, []);

  const saveId = async () => {
    const n = parseInt(entryId, 10);
    if (!Number.isInteger(n) || n <= 0) {
      setMsg("Enter a valid FPL entry ID (a number from your team URL).");
      return;
    }
    setBusy(true);
    setMsg(null);
    const sb = createBrowserSupabase();
    const { error } = await sb.from("profiles").upsert({ id: userId, fpl_entry_id: n, updated_at: new Date().toISOString() });
    setBusy(false);
    if (error) setMsg(`Couldn't save: ${error.message}`);
    else {
      setSaved(n);
      setMsg("Saved. Now sync your team below.");
    }
  };

  const sync = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setMsg(data.message ?? data.error ?? "Done.");
    } catch {
      setMsg("Sync request failed — please retry.");
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return <main className="mx-auto w-full max-w-md px-6 py-16 text-sm text-muted-foreground">Loading…</main>;
  }

  if (!userId) {
    return (
      <main className="mx-auto w-full max-w-md px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          <Link href="/login" className="text-emerald-400 hover:underline">Log in</Link> to connect your FPL team.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your Fantasy Premier League team so the app can personalise picks for you.
      </p>

      <div className="mt-6 space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your FPL entry ID
        </label>
        <div className="flex gap-2">
          <input
            inputMode="numeric"
            value={entryId}
            onChange={(e) => setEntryId(e.target.value)}
            placeholder="e.g. 3429940"
            className="h-11 flex-1 rounded-xl border border-border/60 bg-card px-4 text-sm outline-none focus:border-emerald-500/40"
          />
          <button
            onClick={saveId}
            disabled={busy}
            className="h-11 rounded-xl bg-emerald-500/90 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Find it in your team&apos;s URL on the FPL site: fantasy.premierleague.com/entry/<b>ID</b>/event/…
        </p>
      </div>

      {saved != null && (
        <div className="mt-6">
          <button
            onClick={sync}
            disabled={busy}
            className="h-11 w-full rounded-xl border border-border/60 bg-card text-sm font-medium transition-colors hover:border-emerald-500/40 disabled:opacity-40"
          >
            {busy ? "Syncing…" : "Sync my team now"}
          </button>
        </div>
      )}

      {msg && <p className="mt-4 text-sm text-amber-500">{msg}</p>}

      <div className="mt-10 border-t border-border/50 pt-6">
        <TeamUpload
          title="Or upload a team screenshot"
          note="Preseason your squad is private on the FPL API. Screenshot your team (from the FPL app or site) and upload it — the app reads the 15 players, captain, and bench, and loads them as your team."
        />
      </div>
    </main>
  );
}
