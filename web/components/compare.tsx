"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, X, Plus } from "lucide-react";
import type { ComparePlayer } from "@/lib/compare";
import { HORIZONS, type CompareDetail, type Horizon } from "@/lib/compare-detail";
import { CompareDetails, bestIndex } from "@/components/compare-detail";

// Compare 2–3 players, FC Ultimate Team style: a card per player (OVR, position, club, photo, six attributes),
// head-to-head attribute bars, and the key FPL numbers with the best in each row marked. Ratings come from
// lib/compare.ts (ranks within the player pool; the "How the ratings work" list below spells them out).

const MAX = 3;
const ATTRS = [
  { key: "FRM", label: "Form" },
  { key: "ATT", label: "Attack" },
  { key: "DEF", label: "Defence" },
  { key: "MIN", label: "Minutes" },
  { key: "FIX", label: "Fixtures" },
  { key: "VAL", label: "Value" },
] as const;
// Colours that identify each compared player (cool hues; green/red/amber stay reserved for data meaning).
const SLOT_COLORS = ["#22d3ee", "#a78bfa", "#94a3b8"];

type Tier = { bg: string; ink: string; sub: string; ring: string; label: string };
function tier(ovr: number): Tier {
  if (ovr >= 90) return { bg: "linear-gradient(160deg,#0b1430 0%,#13325c 55%,#0a1024 100%)", ink: "#eef2ff", sub: "#7dd3fc", ring: "0 0 0 1px #22d3ee88, 0 14px 40px -12px #22d3eecc", label: "Elite" };
  if (ovr >= 80) return { bg: "linear-gradient(160deg,#fbe8a6 0%,#e7bf55 45%,#b88a2a 100%)", ink: "#2d2107", sub: "#5c4510", ring: "0 14px 34px -14px #e7bf55aa", label: "Gold" };
  if (ovr >= 70) return { bg: "linear-gradient(160deg,#f3f5f8 0%,#c6cbd3 50%,#9ba2ad 100%)", ink: "#1f2430", sub: "#434b59", ring: "0 14px 34px -14px #c6cbd399", label: "Silver" };
  return { bg: "linear-gradient(160deg,#ebc196 0%,#bb7c41 50%,#8a5428 100%)", ink: "#2a1606", sub: "#4f2d10", ring: "0 14px 34px -14px #bb7c4199", label: "Bronze" };
}

const STATUS: Record<string, string> = { d: "Doubtful", i: "Injured", s: "Suspended", n: "Not in squad" };
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** One FC-style card. Sizes are in container units (cqw), so it scales from a phone third to a desktop card. */
function PlayerCard({ p, color, onRemove }: { p: ComparePlayer; color: string; onRemove: () => void }) {
  const t = tier(p.ovr);
  const [photoOk, setPhotoOk] = React.useState(true);
  const initials = p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="rise flex flex-col items-center gap-2">
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

      <div className="flex flex-wrap items-center justify-center gap-x-1.5 text-xs">
        <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
        {p.status !== "a" && (
          <span className="text-center text-[11px] text-amber-400">
            {STATUS[p.status] ?? "Doubt"}{p.chance != null ? ` ${p.chance}%` : ""}
          </span>
        )}
        <button type="button" onClick={onRemove} aria-label={`Remove ${p.name}`} className="flex min-h-9 items-center gap-1 rounded-md px-2 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" aria-hidden /> Remove
        </button>
      </div>
    </div>
  );
}

function EmptySlot({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        className="flex aspect-[0.72] w-full max-w-[230px] flex-col items-center justify-center gap-2 border-2 border-dashed border-border text-muted-foreground hover:border-brand/60 hover:text-foreground"
        style={{ clipPath: "polygon(0 7%, 14% 0, 86% 0, 100% 7%, 100% 87%, 50% 100%, 0 87%)" }}
      >
        <Plus className="size-6" aria-hidden />
        <span className="font-display text-sm">Add player</span>
      </button>
    </div>
  );
}

export function Compare({ players, initial, gws, details, horizon }: { players: ComparePlayer[]; initial: number[]; gws: number[]; details: CompareDetail[]; horizon: Horizon }) {
  const router = useRouter();
  const byId = React.useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const [ids, setIds] = React.useState<number[]>(() => initial.filter((id) => byId.has(id)).slice(0, MAX));
  const [h, setH] = React.useState<Horizon>(horizon);
  const [pending, startTransition] = React.useTransition();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // The cards update at once from the player list; the horizon-based sections come from the server, so a
  // change of players or horizon re-requests the page (?p=…&h=…), which also keeps the URL shareable.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const want = `${ids.join(",")}|${h}`;
    if (`${url.searchParams.get("p") ?? ""}|${url.searchParams.get("h") ?? "5"}` === want) return;
    if (ids.length) url.searchParams.set("p", ids.join(",")); else url.searchParams.delete("p");
    url.searchParams.set("h", String(h));
    startTransition(() => router.replace(`${url.pathname}?${url.searchParams}`, { scroll: false }));
  }, [ids, h, router]);
  const detailById = new Map(details.filter((d) => d.h === h).map((d) => [d.id, d]));

  const chosen = ids.map((id) => byId.get(id)!).filter(Boolean);
  const results = React.useMemo(() => {
    const q = norm(query.trim());
    if (!q) return players.filter((p) => !ids.includes(p.id)).slice(0, 8);
    return players
      .filter((p) => !ids.includes(p.id) && (norm(p.name).includes(q) || norm(p.fullName).includes(q) || norm(p.team) === q))
      .slice(0, 8);
  }, [players, query, ids]);

  const add = (id: number) => {
    setIds((cur) => (cur.length >= MAX || cur.includes(id) ? cur : [...cur, id]));
    setQuery("");
    setOpen(false);
  };
  const remove = (id: number) => setIds((cur) => cur.filter((x) => x !== id));
  const focusSearch = () => { inputRef.current?.focus(); setOpen(true); };

  return (
    <div className="mt-6 space-y-6">
      {/* search */}
      <div className="relative max-w-md">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) add(results[0].id); if (e.key === "Escape") setOpen(false); }}
          disabled={ids.length >= MAX}
          placeholder={ids.length >= MAX ? "Remove a player to add another" : "Add a player: search name or club"}
          aria-label="Search players to compare"
          className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-base outline-none focus:border-brand/60 disabled:opacity-60 sm:text-sm"
        />
        {open && ids.length < MAX && results.length > 0 && (
          <ul role="listbox" className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(p.id)}
                  className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-accent"
                >
                  <span className="w-8 font-display text-base tabular-nums">{p.ovr}</span>
                  <span className="flex-1 truncate">{p.name} <span className="text-xs text-muted-foreground">{p.team} · {p.pos}</span></span>
                  <span className="text-xs tabular-nums text-muted-foreground">£{p.price.toFixed(1)}m · {p.xp5.toFixed(1)} xPts</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-6">
        {Array.from({ length: MAX }, (_, i) =>
          chosen[i] ? (
            <PlayerCard key={chosen[i].id} p={chosen[i]} color={SLOT_COLORS[i]} onRemove={() => remove(chosen[i].id)} />
          ) : (
            <EmptySlot key={`empty-${i}`} onClick={focusSearch} />
          ),
        )}
      </div>

      {chosen.length < 2 ? (
        <p className="text-sm text-muted-foreground">• Add at least two players to compare them</p>
      ) : (
        <>
          {/* head-to-head attributes */}
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="font-display text-lg">Head to head</h2>
            <div className="mt-3 space-y-3">
              {ATTRS.map((a) => {
                const vals = chosen.map((p) => p.attrs[a.key]);
                const best = bestIndex(vals, "high");
                return (
                  <div key={a.key}>
                    <div className="flex items-baseline gap-2">
                      <span className="font-display text-sm">{a.key}</span>
                      <span className="text-xs text-muted-foreground">{a.label}</span>
                    </div>
                    <div className="mt-1 space-y-1">
                      {chosen.map((p, i) => (
                        <div key={p.id} className="flex items-center gap-2">
                          <span className="w-20 truncate text-xs text-muted-foreground sm:w-28">{p.name}</span>
                          <div className="h-2.5 flex-1 overflow-hidden rounded-sm bg-muted">
                            <div className="h-full rounded-sm transition-[width] duration-500" style={{ width: `${vals[i]}%`, backgroundColor: SLOT_COLORS[i] }} />
                          </div>
                          <span className={`w-9 text-right font-display tabular-nums ${best === i ? "text-emerald-400" : ""}`}>
                            {vals[i]}{best === i ? "▲" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* horizon for the sections below the cards */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Horizon</span>
            <div role="radiogroup" aria-label="Horizon" className="inline-flex gap-1 rounded-lg border border-border bg-card p-1">
              {HORIZONS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={h === v}
                  onClick={() => setH(v)}
                  className={`press h-9 rounded-md px-3 font-display text-sm ${h === v ? "bg-grad glow" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {v === 1 ? "Next GW" : `${v} GWs`}
                </button>
              ))}
            </div>
            {pending && <span role="status" className="text-xs text-muted-foreground">Updating…</span>}
          </div>

          <CompareDetails ps={chosen.map((p, i) => ({ p, d: detailById.get(p.id), color: SLOT_COLORS[i] }))} h={h} pending={pending} />
        </>
      )}

      {/* transparency: how each rating is made */}
      <section className="rounded-xl border border-border bg-card p-4 text-sm">
        <h2 className="font-display text-lg">How the ratings work</h2>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>• Ratings re-express each player&apos;s own numbers, they are not new predictions</li>
          <li>• Most are 99 × √(his number ÷ the best player&apos;s): the best gets 99, half the best gets 70, a quarter gets 50 (compared with every player projected 1+ pt over the next {gws.length} GWs)</li>
          <li>• <b className="text-foreground">OVR</b>: projected points over the next {gws.length} GWs</li>
          <li>• <b className="text-foreground">FRM</b>: FPL form (points per game over the last 30 days)</li>
          <li>• <b className="text-foreground">ATT</b>: season xG + xA per 90 minutes</li>
          <li>• <b className="text-foreground">DEF</b>: projected clean-sheet + defensive-contribution points over the next {gws.length}</li>
          <li>• <b className="text-foreground">MIN</b>: expected minutes per game (90 minutes = 99)</li>
          <li>• <b className="text-foreground">FIX</b>: how easy the next {gws.length} fixtures are (the app&apos;s own difficulty rating), as a rank: 99 = easiest run</li>
          <li>• <b className="text-foreground">VAL</b>: projected points per £1m over the next {gws.length}</li>
          <li>• Card colour follows OVR: Elite 90+, Gold 80+, Silver 70+, Bronze below; ▲ marks the best in each row</li>
        </ul>
      </section>
    </div>
  );
}
