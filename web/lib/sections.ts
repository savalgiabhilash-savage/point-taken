import { Shirt, Search, Sparkles, MessageCircle, type LucideIcon } from "lucide-react";

// The app's 4 top-level tabs, one per job (MECE). Each has its own colour (header stripe and tag, active nav)
// and pill sub-tabs. Colours are cool hues only: green, red and amber carry data meaning in this app. Page URLs are unchanged, so old links still work.
export type Section = {
  key: string;
  label: string;
  Icon: LucideIcon;
  color: string;
  pages: { href: string; label: string; owner?: boolean }[];
};

export const SECTIONS: Section[] = [
  {
    key: "team", label: "My Team", Icon: Shirt, color: "#22d3ee",
    pages: [
      { href: "/team", label: "Live & squad" },
      { href: "/optimizer", label: "Transfers" },
      { href: "/chips", label: "Chips" },
    ],
  },
  {
    key: "scout", label: "Scout", Icon: Search, color: "#60a5fa",
    pages: [
      { href: "/players", label: "Players" },
      { href: "/differentials", label: "Differentials" },
      { href: "/fixtures", label: "Fixtures" },
    ],
  },
  {
    key: "predict", label: "Predict", Icon: Sparkles, color: "#818cf8",
    pages: [
      { href: "/best", label: "Best XI" },
      { href: "/accuracy", label: "Accuracy" },
    ],
  },
  {
    key: "ask", label: "Ask", Icon: MessageCircle, color: "#7dd3fc",
    pages: [
      { href: "/assistant", label: "Assistant" },
      { href: "/guide", label: "Guide" },
      { href: "/docs", label: "Docs", owner: true }, // owner only; /docs is also gated server-side
    ],
  },
];

export const sectionFor = (path: string) =>
  SECTIONS.find((s) => s.pages.some((p) => path === p.href || path.startsWith(p.href + "/")));

/** A section colour used as text: mixed toward the text colour so it stays readable in both themes. */
export const inkMix = (hex: string, pct = 70) => `color-mix(in srgb, ${hex} ${pct}%, var(--foreground))`;
export const tint = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;

/** A section's pages this viewer may see (Docs only for the owner). */
export const visiblePages = (s: Section, owner: boolean) => s.pages.filter((p) => !p.owner || owner);
