"use client";

import * as React from "react";
import type { Insight } from "@/lib/insight";
import { CompareLink } from "@/components/compare-link";

// The "i" on every recommended player. Click opens a panel explaining the pick factor by factor:
// page-specific reasons first ("why"), then the model's own reasoning from /api/insight.
export function PlayerInfo({
  playerId,
  name,
  why,
  className,
}: {
  playerId: number;
  name: string;
  why?: string[];
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`Why ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          className ??
          "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-zinc-700 font-sans text-[10px] font-bold italic leading-none text-white hover:bg-emerald-600"
        }
      >
        i
      </button>
      {open ? <InsightDialog playerId={playerId} name={name} why={why} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function InsightDialog({
  playerId,
  name,
  why,
  onClose,
}: {
  playerId: number;
  name: string;
  why?: string[];
  onClose: () => void;
}) {
  const [data, setData] = React.useState<Insight | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    fetch(`/api/insight?id=${playerId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!active) return;
        if (!r.ok) setError(j.error ?? "Couldn't load this player.");
        else setData(j as Insight);
      })
      .catch(() => active && setError("Couldn't load this player."));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [playerId, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Why ${name}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border/60 bg-card p-5 text-left text-foreground shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{data?.player.name ?? name}</div>
            {data ? (
              <div className="text-xs text-muted-foreground">
                {data.player.position} · {data.player.team} · £{data.player.price.toFixed(1)}m ·{" "}
                {data.player.ownership.toFixed(1)}% owned
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {why && why.length > 0 ? <Section title="Why this pick" bullets={why} accent /> : null}

        {error ? <p className="mt-4 text-sm text-rose-400">{error}</p> : null}
        {!data && !error ? <p className="mt-4 text-sm text-muted-foreground">Loading the model&apos;s reasoning…</p> : null}
        {data?.sections.map((s) => <Section key={s.title} title={s.title} bullets={s.bullets} />)}
        {data ? <CompareLink playerId={playerId} className="mt-4" /> : null}
      </div>
    </div>
  );
}

function Section({ title, bullets, accent }: { title: string; bullets: string[]; accent?: boolean }) {
  if (!bullets.length) return null;
  return (
    <div className="mt-4">
      <div className={`text-xs font-medium uppercase tracking-wide ${accent ? "text-emerald-400" : "text-muted-foreground"}`}>
        {title}
      </div>
      <ul className="mt-1.5 space-y-1 text-sm">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-0.5 text-emerald-400">•</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
