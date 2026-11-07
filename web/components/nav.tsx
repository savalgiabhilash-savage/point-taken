"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isOwnerEmail } from "@/lib/owner";
import { Shirt, TrendingUp, Users, Zap, Menu, X } from "lucide-react";

const ITEMS = [
  { href: "/players", label: "Players" },
  { href: "/fixtures", label: "Fixtures" },
  { href: "/team", label: "My Team" },
  { href: "/optimizer", label: "Optimizer" },
  { href: "/chips", label: "Chips" },
  { href: "/differentials", label: "Differentials" },
  { href: "/best", label: "Best XI" },
  { href: "/accuracy", label: "Accuracy" },
  { href: "/assistant", label: "Assistant" },
  { href: "/guide", label: "Guide" },
];

// Phones and tablets: a fixed bottom bar with the 4 most-used tabs + More (best practice: 3-5 labelled
// destinations within thumb reach); the rest open in a sheet above the bar.
const TABS = [
  { href: "/team", label: "My Team", Icon: Shirt },
  { href: "/optimizer", label: "Optimizer", Icon: TrendingUp },
  { href: "/players", label: "Players", Icon: Users },
  { href: "/chips", label: "Chips", Icon: Zap },
];

function useOwner() {
  // The Docs tab is shown only to the owner; /docs itself is gated server-side.
  const [owner, setOwner] = React.useState(false);
  React.useEffect(() => {
    const sb = createBrowserSupabase();
    sb.auth.getUser().then(({ data }) => setOwner(isOwnerEmail(data.user?.email)));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => setOwner(isOwnerEmail(session?.user?.email)));
    return () => sub.subscription.unsubscribe();
  }, []);
  return owner ? [...ITEMS, { href: "/docs", label: "Docs" }] : ITEMS;
}

export function Nav() {
  const path = usePathname();
  const items = useOwner();
  return (
    <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm lg:flex">
      {items.map((it) => {
        const active = path === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={
              active
                ? "rounded-md bg-emerald-500/10 px-3 py-1.5 font-medium text-emerald-400"
                : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileTabs() {
  const path = usePathname();
  const items = useOwner();
  const [open, setOpen] = React.useState(false);
  const [prev, setPrev] = React.useState(path);
  if (prev !== path) { setPrev(path); setOpen(false); } // close the sheet after navigating
  const more = [...items.filter((it) => !TABS.some((t) => t.href === it.href)), { href: "/settings", label: "Settings" }];
  const moreActive = more.some((it) => it.href === path);
  const tab = (active: boolean) =>
    `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? "text-emerald-400" : "text-muted-foreground"}`;
  return (
    <div className="lg:hidden">
      {open && (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-30 bg-black/50" onClick={() => setOpen(false)} />
          <nav className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 grid grid-cols-2 gap-1 border-t border-border/60 bg-background p-3">
            {more.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={`flex min-h-11 items-center rounded-md px-3 text-sm ${it.href === path ? "bg-emerald-500/10 font-medium text-emerald-400" : "text-foreground hover:bg-muted/50"}`}
              >
                {it.label}
              </Link>
            ))}
          </nav>
        </>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border/60 bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        {TABS.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className={tab(path === href)} aria-current={path === href ? "page" : undefined}>
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        ))}
        <button type="button" className={tab(open || moreActive)} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          More
        </button>
      </nav>
    </div>
  );
}
