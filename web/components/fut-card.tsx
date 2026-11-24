"use client";

import * as React from "react";
import type { ComparePlayer } from "@/lib/compare";

// The FC Ultimate Team style player card (Compare, Scout -> Form). Sizes are in container units (cqw), so it
// scales from a phone third to a desktop card. Ratings come from lib/compare.ts.

export const ATTRS = [
  { key: "FRM", label: "Form" },
  { key: "ATT", label: "Attack" },
  { key: "DEF", label: "Defence" },
  { key: "MIN", label: "Minutes" },
  { key: "FIX", label: "Fixtures" },
  { key: "VAL", label: "Value" },
] as const;

export type Tier = { bg: string; ink: string; sub: string; ring: string; label: string };
function tier(ovr: number): Tier {
  if (ovr >= 90) return { bg: "linear-gradient(160deg,#0b1430 0%,#13325c 55%,#0a1024 100%)", ink: "#eef2ff", sub: "#7dd3fc", ring: "0 0 0 1px #22d3ee88, 0 14px 40px -12px #22d3eecc", label: "Elite" };
  if (ovr >= 80) return { bg: "linear-gradient(160deg,#fbe8a6 0%,#e7bf55 45%,#b88a2a 100%)", ink: "#2d2107", sub: "#5c4510", ring: "0 14px 34px -14px #e7bf55aa", label: "Gold" };
  if (ovr >= 70) return { bg: "linear-gradient(160deg,#f3f5f8 0%,#c6cbd3 50%,#9ba2ad 100%)", ink: "#1f2430", sub: "#434b59", ring: "0 14px 34px -14px #c6cbd399", label: "Silver" };
  return { bg: "linear-gradient(160deg,#ebc196 0%,#bb7c41 50%,#8a5428 100%)", ink: "#2a1606", sub: "#4f2d10", ring: "0 14px 34px -14px #bb7c4199", label: "Bronze" };
}

/** One FC-style card. */
export function FutCard({ p }: { p: ComparePlayer }) {
  const t = tier(p.ovr);
  const [photoOk, setPhotoOk] = React.useState(true);
  const initials = p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="@container relative w-full max-w-[230px]">
      <div
        className="relative aspect-[0.72] w-full overflow-hidden"
        style={{
          background: t.bg,
          color: t.ink,
          boxShadow: t.ring,
          clipPath: "polygon(0 7%, 14% 0, 86% 0, 100% 7%, 100% 87%, 50% 100%, 0 87%)",
        }}
      >
        {/* sheen + fine pattern, like a printed card */}
        <span aria-hidden className="absolute inset-0 bg-[linear-gradient(115deg,transparent_30%,rgba(255,255,255,.35)_45%,transparent_60%)] opacity-60" />
        <span aria-hidden className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.06)_0_2px,transparent_2px_9px)]" />

        {/* rating, position, club */}
        <div className="absolute left-[9cqw] top-[11cqw] flex flex-col items-center leading-none">
          <span className="font-display text-[22cqw]">{p.ovr}</span>
          <span className="font-display text-[9cqw]">{p.pos}</span>
          <span className="mt-[2cqw] h-px w-[11cqw]" style={{ backgroundColor: t.sub }} />
          <span className="mt-[2cqw] text-[6.5cqw] font-bold">{p.team}</span>
        </div>

        {/* photo (FPL's own player photo), initials if it doesn't load */}
        <div className="absolute right-[5cqw] top-[9cqw] flex h-[56cqw] w-[52cqw] items-end justify-center">
          {p.photo && photoOk ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote FPL photo, small, decorative
            <img src={p.photo} alt="" loading="lazy" onError={() => setPhotoOk(false)} className="h-full w-full object-contain object-bottom drop-shadow-[0_6px_8px_rgba(0,0,0,.35)]" />
          ) : (
            <span className="font-display text-[20cqw] opacity-70">{initials}</span>
          )}
        </div>

        {/* name */}
        <div className="absolute inset-x-[6cqw] top-[68cqw] text-center">
          <div className="truncate font-display text-[11cqw]">{p.name}</div>
          <div className="mx-auto mt-[1.5cqw] h-px w-[70%]" style={{ backgroundColor: t.sub, opacity: 0.6 }} />
        </div>

        {/* six attributes, two columns */}
        <div className="absolute inset-x-[12cqw] top-[85cqw] grid grid-cols-2 gap-x-[6cqw] gap-y-[1.5cqw]">
          {ATTRS.map((a) => (
            <div key={a.key} className="flex items-baseline gap-[2cqw] leading-none">
              <span className="font-display text-[10cqw] tabular-nums">{p.attrs[a.key]}</span>
              <span className="text-[6.5cqw] font-semibold" style={{ color: t.sub }}>{a.key}</span>
            </div>
          ))}
        </div>

        {/* price at the point of the shield */}
        <div className="absolute inset-x-0 top-[122cqw] text-center text-[6.5cqw] font-bold" style={{ color: t.sub }}>
          £{p.price.toFixed(1)}m · {t.label}
        </div>
      </div>
    </div>
  );
}
