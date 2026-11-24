// Play style: a user's risk profile and goal (profiles.risk / profiles.goal, migration 0018). The optimizer
// plans with the risk profile (worker/fpl_worker/risk.py); the goal routes the user to the right feature.

export type Risk = "safe" | "balanced" | "bold";
export type Goal = "this_gw" | "long_term" | "mini_league" | "rank" | "chips";

export const RISK: Record<Risk, { label: string; blurb: string }> = {
  safe: { label: "Safe", blurb: "High floors, template picks, no rotation risks, hits only when clear-cut" },
  balanced: { label: "Balanced", blurb: "The most expected points (the app's default)" },
  bold: { label: "Bold", blurb: "High ceilings and differentials, more willing to take a −4" },
};

// Each goal: a label and where to act on it (first link = the main one).
export const GOALS: Record<Goal, { label: string; links: { href: string; label: string }[] }> = {
  this_gw: { label: "Best score this gameweek", links: [{ href: "/best", label: "Best XI" }, { href: "/team", label: "Captain & bench" }] },
  long_term: { label: "Plan transfers for the coming weeks", links: [{ href: "/optimizer", label: "Transfer plan" }, { href: "/fixtures", label: "Fixtures" }] },
  mini_league: { label: "Beat my mini-league", links: [{ href: "/team", label: "League gaps" }, { href: "/differentials", label: "Differentials" }] },
  rank: { label: "Climb my overall rank", links: [{ href: "/optimizer", label: "Transfer plan" }, { href: "/form", label: "In-form picks" }] },
  chips: { label: "Get the most from my chips", links: [{ href: "/chips", label: "Chips" }, { href: "/optimizer", label: "Plan" }] },
};

export type Question = { q: string; options: { label: string; score: number; goal?: Goal }[] };

// Five questions. Q1 sets the goal; the risk score is the sum of the other four (each −1 … +1).
export const QUIZ: Question[] = [
  {
    q: "What matters most to you right now?",
    options: [
      { label: "The best score this gameweek", score: 0, goal: "this_gw" },
      { label: "Planning transfers for the coming weeks", score: 0, goal: "long_term" },
      { label: "Beating my mini-league", score: 0, goal: "mini_league" },
      { label: "Climbing my overall rank", score: 0, goal: "rank" },
      { label: "Timing my chips well", score: 0, goal: "chips" },
    ],
  },
  {
    q: "Your captain blanks while the popular pick hauls. How does that feel?",
    options: [
      { label: "Awful: I'd rather captain who everyone has", score: -1 },
      { label: "It happens", score: 0 },
      { label: "Fine: my pick will win other weeks", score: 1 },
    ],
  },
  {
    q: "Would you take a −4 hit for a player you're confident in?",
    options: [
      { label: "Rarely: hits are costly", score: -1 },
      { label: "If the numbers say so", score: 0 },
      { label: "Yes, I'll chase a good move", score: 1 },
    ],
  },
  {
    q: "A cheaper player with big upside, but he might not start. In or out?",
    options: [
      { label: "Out: I want nailed starters", score: -1 },
      { label: "Depends on the price", score: 0 },
      { label: "In: upside wins", score: 1 },
    ],
  },
  {
    q: "Template squad or your own picks?",
    options: [
      { label: "Template: don't fall behind", score: -1 },
      { label: "Mostly template, a few of my own", score: 0 },
      { label: "My own: differentials win leagues", score: 1 },
    ],
  },
];

export function scoreQuiz(answers: number[]): { risk: Risk; goal: Goal | null } {
  const goal = QUIZ[0].options[answers[0]]?.goal ?? null;
  const total = answers.slice(1).reduce((s, a, i) => s + (QUIZ[i + 1].options[a]?.score ?? 0), 0);
  return { risk: total <= -2 ? "safe" : total >= 2 ? "bold" : "balanced", goal };
}

export const asRisk = (v: unknown): Risk => (v === "safe" || v === "bold" ? v : "balanced");
export const asGoal = (v: unknown): Goal | null => (typeof v === "string" && v in GOALS ? (v as Goal) : null);
