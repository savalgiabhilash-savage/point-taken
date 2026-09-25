"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isOwnerEmail } from "@/lib/owner";

const ITEMS = [
  { href: "/players", label: "Players" },
  { href: "/fixtures", label: "Fixtures" },
  { href: "/team", label: "My Team" },
  { href: "/optimizer", label: "Optimizer" },
  { href: "/best", label: "Best XI" },
  { href: "/assistant", label: "Assistant" },
  { href: "/guide", label: "Guide" },
];

export function Nav() {
  const path = usePathname();
  // The Docs tab is shown only to the owner; /docs itself is gated server-side.
  const [owner, setOwner] = React.useState(false);
  React.useEffect(() => {
    const sb = createBrowserSupabase();
    sb.auth.getUser().then(({ data }) => setOwner(isOwnerEmail(data.user?.email)));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => setOwner(isOwnerEmail(session?.user?.email)));
    return () => sub.subscription.unsubscribe();
  }, []);
  const items = owner ? [...ITEMS, { href: "/docs", label: "Docs" }] : ITEMS;
  return (
    <nav className="flex items-center gap-1 text-sm">
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
