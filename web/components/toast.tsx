"use client";

import * as React from "react";
import { CheckCircle2, AlertCircle, Loader2, X } from "lucide-react";

// Minimal toasts: toast() from anywhere, <Toaster /> once in the layout. A toast with an id replaces the
// one with the same id (e.g. "loading" → "success"). Loading toasts stay until replaced; others clear after 5 s.
type Kind = "loading" | "success" | "error";
type Toast = { id: string; text: string; kind: Kind };
const EVENT = "app-toast";

export function toast(text: string, kind: Kind = "success", id: string = Math.random().toString(36)) {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id, text, kind } }));
}

export function Toaster() {
  const [items, setItems] = React.useState<Toast[]>([]);
  React.useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setItems((cur) => [...cur.filter((x) => x.id !== t.id), t]);
      clearTimeout(timers.get(t.id));
      if (t.kind !== "loading") timers.set(t.id, setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 5000));
    };
    window.addEventListener(EVENT, onToast);
    return () => { window.removeEventListener(EVENT, onToast); timers.forEach(clearTimeout); };
  }, []);

  return (
    // Above the mobile tab bar; bottom-right on desktop.
    <div aria-live="polite" className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 xl:inset-x-auto xl:bottom-6 xl:right-6 xl:items-end">
      {items.map((t) => (
        <div key={t.id} role="status" className="pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-sm shadow-lg">
          {t.kind === "loading" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-emerald-400" />
            : t.kind === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            : <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-400" />}
          <span className="flex-1">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))} className="-m-1.5 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
