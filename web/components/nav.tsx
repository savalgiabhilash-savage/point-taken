"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  return (
    <nav className="flex items-center gap-1 text-sm">
      {ITEMS.map((it) => {
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
