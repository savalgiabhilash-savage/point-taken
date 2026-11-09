"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SECTIONS, sectionFor, inkMix, tint, visiblePages } from "@/lib/sections";
import { useOwner } from "@/lib/use-owner";
import { AccountMenu } from "@/components/auth-button";

function Logo() {
  return (
    <Link href="/players" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-display text-lg">
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static icon, no optimisation needed */}
      <img src="/icon-192.png" alt="" width={32} height={32} className="size-8 rounded-xl glow" />
      <span className="text-grad">FPL Selector</span>
    </Link>
  );
}

// One nav item, shared by the phone bar and the desktop sidebar: icon + condensed-caps label. Active: the tab's
// colour (mixed toward the text colour for contrast), a soft tint, and a scoreboard-style indicator bar (top
// edge on the phone bar, left edge in the sidebar).
function Item({ s, active, vertical }: { s: (typeof SECTIONS)[number]; active: boolean; vertical: boolean }) {
  const { Icon } = s;
  return (
    <Link
      href={s.pages[0].href}
      aria-current={active ? "page" : undefined}
      className={`press relative flex items-center rounded-lg font-display tracking-wide transition-colors ${
        vertical ? "min-h-11 gap-3 px-3 text-[17px]" : "min-h-14 flex-1 flex-col justify-center gap-0.5 text-[13px]"
      } ${active ? "" : "text-muted-foreground hover:text-foreground"}`}
      style={active ? { color: inkMix(s.color, 80), backgroundColor: tint(s.color, 0.12) } : undefined}
    >
      {active && (
        <span
          aria-hidden
          className={vertical ? "absolute inset-y-2 left-0 w-1 rounded-r" : "absolute inset-x-4 top-0 h-[3px] rounded-b"}
          style={{ backgroundColor: s.color, boxShadow: `0 0 12px ${tint(s.color, 0.8)}` }}
        />
      )}
      <Icon aria-hidden className="size-5" />
      {s.label}
    </Link>
  );
}

/** Desktop and tablet (md+): a left sidebar with the app name, the 4 tabs with every page listed under each,
 *  and the account menu. */
export function Sidebar() {
  const path = usePathname();
  const owner = useOwner();
  const cur = sectionFor(path);
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-sidebar/70 px-3 py-5 md:flex lg:w-60">
      <div className="px-2"><Logo /></div>
      <nav aria-label="Main" className="mt-8 flex min-h-0 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
        {SECTIONS.map((s) => (
          <div key={s.key}>
            <Item s={s} active={cur?.key === s.key} vertical />
            <ul className="mb-2 ml-[1.375rem] mt-0.5 border-l border-border pl-3">
              {visiblePages(s, owner).map((p) => {
                const on = path === p.href || path.startsWith(p.href + "/");
                return (
                  <li key={p.href}>
                    <Link
                      href={p.href}
                      aria-current={on ? "page" : undefined}
                      className={`flex min-h-9 items-center rounded-md px-2 text-sm ${on ? "font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                      style={on ? { color: inkMix(s.color) } : undefined}
                    >
                      {p.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="mt-auto pt-3"><AccountMenu placement="side" /></div>
    </aside>
  );
}

/** Phones: a slim top bar (app name + account) and a floating glass tab bar at the bottom. */
export function MobileTop() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-xl md:hidden">
      <Logo />
      <AccountMenu placement="top" />
    </header>
  );
}

export function MobileTabs() {
  const path = usePathname();
  const cur = sectionFor(path);
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-40 flex gap-1 rounded-2xl border border-border bg-card/85 p-1.5 shadow-[0_12px_40px_-12px_rgba(0,0,0,.6)] backdrop-blur-xl md:hidden"
    >
      {SECTIONS.map((s) => <Item key={s.key} s={s} active={cur?.key === s.key} vertical={false} />)}
    </nav>
  );
}
