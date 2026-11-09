"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionFor, tint, visiblePages } from "@/lib/sections";
import { useOwner } from "@/lib/use-owner";

/** Faint pitch markings (halfway line, centre circle, spot, penalty area) for header backgrounds. */
function PitchLines({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 240 200" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2" y="2" width="236" height="196" />
      <line x1="120" y1="2" x2="120" y2="198" />
      <circle cx="120" cy="100" r="38" />
      <circle cx="120" cy="100" r="2.5" fill="currentColor" />
      <rect x="2" y="50" width="40" height="100" />
      <rect x="198" y="50" width="40" height="100" />
    </svg>
  );
}

/**
 * Top of every screen, styled like a TV lower-third: a tab-colour stripe on the left, the tab name in a skewed
 * tag, the title in condensed caps, the page's bullet notes (children), faint pitch markings and a floodlight
 * glow. From 768 px the tab's pill sub-tabs follow (phones show them in a sticky bar instead). The tab and
 * colour come from the URL, so pages only pass a title.
 */
export function PageHeader({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode }) {
  const path = usePathname();
  const owner = useOwner();
  const s = sectionFor(path);
  const color = s?.color ?? "#22d3ee";
  return (
    <>
      <header className="rise relative overflow-hidden rounded-xl border border-border bg-card">
        <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
        <span aria-hidden className="pointer-events-none absolute -top-28 left-1/4 h-52 w-96 rounded-full blur-3xl" style={{ backgroundColor: tint(color, 0.16) }} />
        <PitchLines className="pointer-events-none absolute -right-16 top-1/2 h-[230px] -translate-y-1/2 text-[color:var(--pitch-line)]" />
        <div className="relative flex items-center justify-between gap-4 py-5 pl-6 pr-5">
          <div className="min-w-0">
            {s && (
              <span className="inline-block -skew-x-12 px-2 py-0.5" style={{ backgroundColor: color }}>
                <span className="inline-block skew-x-12 text-[11px] font-bold uppercase tracking-[0.16em] text-[#06132a]">{s.label}</span>
              </span>
            )}
            <h1 className="mt-2 font-display text-[34px] sm:text-[40px]">{title}</h1>
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
        {children && <div className="relative space-y-1.5 pb-5 pl-6 pr-5 text-sm text-muted-foreground [&_ul]:space-y-0.5">{children}</div>}
      </header>
      {s && visiblePages(s, owner).length > 1 && <SubTabs pages={visiblePages(s, owner)} path={path} className="mt-3 hidden md:flex" />}
    </>
  );
}

/** Phones: the current tab's pages as a sticky pill row right under the top bar, always in view. */
export function SectionPills() {
  const path = usePathname();
  const owner = useOwner();
  const s = sectionFor(path);
  if (!s || visiblePages(s, owner).length < 2) return null;
  return (
    <div className="sticky top-14 z-20 border-b border-border/70 bg-background/80 px-4 py-2 backdrop-blur-xl md:hidden">
      <SubTabs pages={visiblePages(s, owner)} path={path} className="flex" />
    </div>
  );
}

function SubTabs({ pages, path, className }: { pages: { href: string; label: string }[]; path: string; className: string }) {
  return (
    <nav aria-label="Section" className={`fade-right -mx-1 gap-2 overflow-x-auto px-1 pb-1 pr-8 [scrollbar-width:none] ${className}`}>
      {pages.map((p) => {
        const active = path === p.href || path.startsWith(p.href + "/");
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={active ? "page" : undefined}
            className={`press inline-flex h-10 shrink-0 items-center rounded-md px-4 font-display text-[15px] tracking-wide whitespace-nowrap ${
              active ? "bg-grad glow" : "border border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Appearance picker: Dark (default), Light, or Match device. Saved per device; applied before paint by layout.tsx. */
export function ThemePicker() {
  const [mode, setMode] = React.useState<string | null>(null);
  React.useEffect(() => {
    let m = "dark";
    try { m = localStorage.getItem("theme") ?? "dark"; } catch {}
    const t = setTimeout(() => setMode(m), 0);
    return () => clearTimeout(t);
  }, []);
  const pick = (m: string) => {
    try { localStorage.setItem("theme", m); } catch {}
    setMode(m);
    (window as { applyTheme?: () => void }).applyTheme?.();
  };
  const opts = [["dark", "Dark"], ["light", "Light"], ["system", "Match device"]] as const;
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-card p-1">
      {opts.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={mode === v}
          onClick={() => pick(v)}
          className={`press h-10 rounded-md text-sm font-semibold ${mode === v ? "bg-grad glow" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
