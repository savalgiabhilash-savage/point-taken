"use client";

import * as React from "react";
import { Download, X } from "lucide-react";

// "Install the app" card: steps for the visitor's own device, a one-tap Install button where the browser
// offers one (Android / desktop Chrome and Edge), hidden inside the installed app and once dismissed.
type Platform = "ios-safari" | "ios-chrome" | "android" | "desktop";
type BipEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const DISMISS_KEY = "install-card-dismissed";

function detect(): { platform: Platform; installed: boolean; dismissed: boolean } {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const platform: Platform = ios ? (/CriOS/.test(ua) ? "ios-chrome" : "ios-safari") : /Android/.test(ua) ? "android" : "desktop";
  const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === "1"; } catch {}
  return { platform, installed, dismissed };
}

const STEPS: Record<Platform, string[]> = {
  "ios-safari": [
    "Tap the Share button (square with an arrow) in Safari's toolbar",
    "Scroll down and tap Add to Home Screen, then Add",
    "Open FPL Selector from your home screen and log in once",
  ],
  "ios-chrome": [
    "Tap the Share button at the right of Chrome's address bar",
    "Tap Add to Home Screen, then Add",
    "Open FPL Selector from your home screen and log in once",
  ],
  android: [
    "Tap Install below if shown, or Chrome's ⋮ menu → Add to Home screen → Install",
    "Open FPL Selector from your home screen",
  ],
  desktop: [
    "Click Install below if shown, or the install icon at the right of the address bar (Chrome / Edge); in Safari on a Mac: File → Add to Dock",
    "It opens in its own window, like a desktop app",
  ],
};

export function InstallCard() {
  const [info, setInfo] = React.useState<ReturnType<typeof detect> | null>(null);
  const [prompt, setPrompt] = React.useState<BipEvent | null>(null);

  React.useEffect(() => {
    // Device checks only work in the browser, so the card appears after the first render.
    const t = setTimeout(() => setInfo(detect()), 0);
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as BipEvent); };
    const onInstalled = () => setInfo((i) => (i ? { ...i, installed: true } : i));
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      clearTimeout(t);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!info || info.installed || info.dismissed) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
    setInfo({ ...info, dismissed: true });
  };
  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
  };

  return (
    <section className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Download className="size-4 text-emerald-400" aria-hidden />
          <h2 className="text-sm font-semibold">Install the app on your {info.platform === "desktop" ? "computer" : "phone"}</h2>
        </div>
        <button type="button" onClick={dismiss} aria-label="Hide install instructions" className="-m-2 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        <li className="text-muted-foreground">• Opens full screen from your home screen, starts on My Team, no browser bars</li>
        {STEPS[info.platform].map((s, i) => <li key={s}>{i + 1}. {s}</li>)}
      </ul>
      {prompt && (
        <button type="button" onClick={install} className="mt-3 inline-flex h-11 items-center gap-2 rounded-lg bg-emerald-500/90 px-4 text-sm font-medium text-white hover:bg-emerald-500">
          <Download className="size-4" aria-hidden /> Install FPL Selector
        </button>
      )}
    </section>
  );
}
