"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useLiveReload } from "@/components/live-gw";

const TRIGGER = 70; // px pulled before release refreshes

// Pull down from the top of the page (touch) to re-read the page data and the live points without a full
// reload. The browser's own pull-to-reload is turned off while this page is open so the two don't clash.
export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const reloadLive = useLiveReload();
  const [pull, setPull] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const start = React.useRef<number | null>(null);

  React.useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overscrollBehaviorY;
    html.style.overscrollBehaviorY = "contain";
    return () => { html.style.overscrollBehaviorY = prev; };
  }, []);

  const refresh = async () => {
    setBusy(true);
    router.refresh();
    await reloadLive?.();
    setBusy(false);
  };

  return (
    <div
      onTouchStart={(e) => { start.current = window.scrollY <= 0 ? e.touches[0].clientY : null; }}
      onTouchMove={(e) => {
        if (start.current == null || busy) return;
        const d = e.touches[0].clientY - start.current;
        setPull(d > 0 ? Math.min(d * 0.5, TRIGGER * 1.4) : 0);
      }}
      onTouchEnd={() => {
        if (pull >= TRIGGER && !busy) refresh();
        setPull(0);
        start.current = null;
      }}
    >
      <div
        className="flex items-center justify-center overflow-hidden text-xs text-muted-foreground transition-[height] duration-150"
        style={{ height: busy ? 40 : pull }}
        aria-hidden={!busy && pull === 0}
      >
        <RefreshCw
          className={`mr-1.5 size-4 ${busy ? "animate-spin text-emerald-400" : ""}`}
          style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }}
        />
        {busy ? "Refreshing…" : pull >= TRIGGER ? "Release to refresh" : "Pull to refresh"}
      </div>
      {children}
    </div>
  );
}
