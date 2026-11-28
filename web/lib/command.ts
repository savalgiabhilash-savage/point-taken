// The command box ("type what you want"): where each request can go. Shared by the box (instant page
// suggestions as you type) and /api/command (Claude picks a page, a task or a written answer).

export type Dest = { key: string; href: string; label: string; desc: string; words: string };

export const DESTS: Dest[] = [
  { key: "team", href: "/team", label: "Live & squad", desc: "your squad, live points, rank, this week's to-do", words: "my team squad live points rank score gameweek this week bench lineup line-up" },
  { key: "optimizer", href: "/optimizer", label: "Transfers", desc: "the optimizer's transfer plan, captain, hits, horizon and play style", words: "transfer transfers optimizer optimise optimize plan hit hits buy sell replace captain captaincy horizon" },
  { key: "chips", href: "/chips", label: "Chips", desc: "chip plan: wildcard, free hit, bench boost, triple captain", words: "chip chips wildcard free hit freehit bench boost triple captain tc bb wc fh" },
  { key: "players", href: "/players", label: "Players", desc: "every player's projected points (xPts) with the breakdown", words: "players xpts projections stats table all players cheap budget" },
  { key: "form", href: "/form", label: "Form", desc: "clubs and players in form (last 6 games); hot picks", words: "form in form hot picks trending clubs teams" },
  { key: "differentials", href: "/differentials", label: "Differentials", desc: "low-owned picks with high xPts", words: "differential differentials low owned punt punts template" },
  { key: "fixtures", href: "/fixtures", label: "Fixtures", desc: "fixture ticker: how easy each club's next fixtures are", words: "fixture fixtures ticker difficulty fdr easy hard schedule run" },
  { key: "compare", href: "/compare", label: "Compare", desc: "2-3 players side by side", words: "compare vs versus or head to head" },
  { key: "best", href: "/best", label: "Best XI", desc: "the best possible team this gameweek", words: "best xi best team dream team eleven" },
  { key: "accuracy", href: "/accuracy", label: "Accuracy", desc: "how accurate past predictions were", words: "accuracy accurate predictions track record how good" },
  { key: "assistant", href: "/assistant", label: "Assistant", desc: "chat with the assistant", words: "assistant chat ask" },
  { key: "guide", href: "/guide", label: "Guide", desc: "how the app works", words: "guide help how works explain" },
  { key: "settings", href: "/settings", label: "Settings", desc: "FPL ID, sync team, play style quiz, notifications, appearance", words: "settings sync fpl id play style quiz risk notifications theme dark light appearance account" },
];

/** Page suggestions for what's typed so far: pages whose label or keywords contain the typed words. */
export function suggest(q: string): { dest: Dest; strong: boolean }[] {
  const words = q.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  return DESTS.map((d) => {
    const hay = ` ${d.label.toLowerCase()} ${d.words} `;
    const hits = words.filter((w) => hay.includes(` ${w}`)).length;
    // Strong: every typed word matched and it's short (e.g. "fixtures", "free hit"), so Enter can go straight there.
    return { dest: d, hits, strong: hits === words.length && words.length <= 2 };
  })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4)
    .map(({ dest, strong }) => ({ dest, strong }));
}

// Tasks the box can do (after the user confirms in the pop-up).
export type Task =
  | { kind: "reoptimize"; horizon: number }
  | { kind: "set_risk"; risk: "safe" | "balanced" | "bold" }
  | { kind: "sync_team" };

export const taskLabel = (t: Task) =>
  t.kind === "reoptimize"
    ? `Re-run the optimizer over ${t.horizon} GW${t.horizon === 1 ? "" : "s"}`
    : t.kind === "set_risk"
      ? `Switch play style to ${t.risk[0].toUpperCase()}${t.risk.slice(1)} (re-plans your transfers)`
      : "Sync your team from FPL";
