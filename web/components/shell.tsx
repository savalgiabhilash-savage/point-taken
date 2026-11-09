"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionFor, inkMix, tint, visiblePages } from "@/lib/sections";
import { useOwner } from "@/lib/use-owner";

/**
 * Top of every screen: a card with two soft glows (the tab's colour + cyan), the tab name as an eyebrow, the
 * page title, its bullet notes (children) and an optional right slot. Below it, the tab's pill sub-tabs.
 * The tab and colour come from the URL, so pages only pass a title.
 */
export function PageHeader({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode }) {
  const path = usePathname();
  const owner = useOwner();
  const s = sectionFor(path);
  const color = s?.color ?? "#34d399";
  return (
    <>
      <header className="rise relative overflow-hidden rounded-3xl border border-border bg-card px-5 py-6">
        <span aria-hidden className="pointer-events-none absolute -left-16 -top-20 h-56 w-56 rounded-full blur-3xl" style={{ backgroundColor: tint(color, 0.3) }} />
        <span aria-hidden className="pointer-events-none absolute -bottom-24 right-0 h-48 w-48 rounded-full bg-brand-2/15 blur-3xl" />
        <div className="relative flex items-center justify-between gap-4">
          <div className="min-w-0">
            {s && <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: inkMix(color) }}>{s.label}</p>}
            <h1 className="mt-1 font-display text-[28px] leading-tight sm:text-3xl">{title}</h1>
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
        {children && <div className="relative mt-3 space-y-1.5 text-sm text-muted-foreground [&_ul]:space-y-0.5">{children}</div>}
      </header>
      {/* Phones show these pills in a sticky bar under the top bar instead (SectionPills in the layout). */}
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
            className={`press inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm font-medium whitespace-nowrap ${
              active ? "bg-grad text-white glow" : "border border-border bg-card text-muted-foreground hover:text-foreground"
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
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1 rounded-full border border-border bg-card p-1">
      {opts.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={mode === v}
          onClick={() => pick(v)}
          className={`press h-10 rounded-full text-sm font-medium ${mode === v ? "bg-grad text-white glow" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
