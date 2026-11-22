"use client";

import * as React from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { toast } from "@/components/toast";

// Settings → Notifications: turn push on for this device and choose what to get. Subscriptions live in
// push_subscriptions (one per device); the worker sends deadline reminders and injury alerts.

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Support = "ok" | "ios-browser" | "none" | "blocked";

export function Notifications() {
  const [support, setSupport] = React.useState<Support | null>(null);
  const [sub, setSub] = React.useState<PushSubscription | null>(null);
  const [prefs, setPrefs] = React.useState({ deadline: true, injuries: true });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setSupport(ios ? "ios-browser" : "none");
        return;
      }
      setSupport(Notification.permission === "denied" ? "blocked" : "ok");
      const reg = await navigator.serviceWorker.getRegistration("/");
      const s = reg ? await reg.pushManager.getSubscription() : null;
      setSub(s);
      if (s) {
        const { data } = await createBrowserSupabase().from("push_subscriptions").select("deadline, injuries").eq("endpoint", s.endpoint).maybeSingle();
        if (data) setPrefs({ deadline: !!data.deadline, injuries: !!data.injuries });
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const save = async (s: PushSubscription, p = prefs) => {
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: s.toJSON(), ...p }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't save");
  };

  const enable = async () => {
    if (!PUBLIC_KEY) return toast("Notifications aren't configured yet", "error", "push");
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setSupport(perm === "denied" ? "blocked" : "ok");
        return;
      }
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) });
      await save(s);
      setSub(s);
      toast("Notifications on for this device", "success", "push");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't turn notifications on", "error", "push");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!sub) return;
    setBusy(true);
    try {
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
      setSub(null);
      toast("Notifications off for this device", "success", "push");
    } finally {
      setBusy(false);
    }
  };

  const setPref = async (k: "deadline" | "injuries", v: boolean) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    if (sub) await save(sub, next).catch(() => toast("Couldn't save that choice", "error", "push"));
  };

  const test = async () => {
    setBusy(true);
    const res = await fetch("/api/push/test", { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    toast(res.ok ? "Test sent: it should appear in a few seconds" : (j.error ?? "Test failed"), res.ok ? "success" : "error", "push");
  };

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-5">
      <h2 className="font-display text-lg">Notifications</h2>
      <ul className="mt-0.5 space-y-0.5 text-sm text-muted-foreground">
        <li>• Deadline reminder about 1½ hours before each deadline, with your plan</li>
        <li>• Injury alert when a player in your squad is newly flagged</li>
      </ul>

      {support == null ? null : support === "ios-browser" ? (
        <p className="mt-3 text-sm text-amber-400">• On iPhone, add Point Taken to your home screen first (Guide → Install the app), then turn notifications on inside the installed app</p>
      ) : support === "none" ? (
        <p className="mt-3 text-sm text-amber-400">• This browser doesn&apos;t support notifications; try Chrome, Edge or the installed app</p>
      ) : support === "blocked" && !sub ? (
        <p className="mt-3 text-sm text-amber-400">• Notifications are blocked for this site; allow them in your browser&apos;s site settings, then come back</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {sub ? (
              <>
                <button type="button" onClick={test} disabled={busy} className="press inline-flex h-10 items-center gap-2 rounded-md bg-grad px-4 text-sm font-bold uppercase tracking-wide glow disabled:opacity-50">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" aria-hidden />} Send a test
                </button>
                <button type="button" onClick={disable} disabled={busy} className="press inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-semibold disabled:opacity-50">
                  <BellOff className="size-4" aria-hidden /> Turn off
                </button>
              </>
            ) : (
              <button type="button" onClick={enable} disabled={busy} className="press inline-flex h-10 items-center gap-2 rounded-md bg-grad px-4 text-sm font-bold uppercase tracking-wide glow disabled:opacity-50">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" aria-hidden />} Turn on for this device
              </button>
            )}
          </div>
          {sub && (
            <div className="mt-3 space-y-2">
              {([["deadline", "Deadline reminders"], ["injuries", "Injury alerts"]] as const).map(([k, label]) => (
                <label key={k} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 text-sm">
                  {label}
                  <input type="checkbox" checked={prefs[k]} onChange={(e) => setPref(k, e.target.checked)} className="size-5 accent-cyan-400" />
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
