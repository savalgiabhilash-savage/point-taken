import { createClient } from "@supabase/supabase-js";

// Some env pipelines (e.g. the Vercel CLI under Windows PowerShell) prepend a UTF-8 BOM (U+FEFF)
// to the stored value; a BOM in the anon key is an illegal HTTP header byte ("Cannot convert
// argument to a ByteString"). Strip any BOM / stray whitespace so the client works regardless of
// how the value was stored. Uses a numeric char-code filter to avoid an invisible BOM in source.
const clean = (v: string | undefined) =>
  [...(v ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();
const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
const anonKey = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/**
 * Server-side Supabase client using the anon key. For now the FPL data tables
 * (teams/players/fixtures/projections) are public read (RLS off), so no auth/session is needed.
 */
export function createSupabaseServerClient() {
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — see web/.env.local.example",
    );
  }
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

export type Position = "GK" | "DEF" | "MID" | "FWD";

/** One named part of the next-GW xPts total, for the transparent breakdown. */
export type BreakdownComponent = { label: string; value: number };
/** One upcoming fixture's projection, for the mini schedule in the detail drawer. */
export type ScheduleItem = { gw: number; xp: number; opp: string | null; fdr: number | null };

/**
 * Advisory news/sentiment signal (Phase 7). Derived from recent headlines classified by Claude.
 * `minutes_risk_adj` is in [-1, 0] and stays advisory — it is NOT folded into the xPts model.
 */
export type NewsSignal = {
  sentiment: string | null;
  topics: string[] | null;
  summary: string | null;
  minutes_risk_adj: number | null;
  url: string | null;
  source: string | null;
  published_at: string | null;
};

/** One player in a logged best-XI prediction (Best XI tab). */
export type BestSquadPlayer = {
  fpl_id: number;
  web_name: string;
  position: Position;
  team_short: string;
  now_cost: number;
  xpn: number;
  is_start: boolean;
  is_captain: boolean;
};
/** The best XI we published for a gameweek, later scored against actual points. */
export type GwPrediction = {
  gw: number;
  variant: "capped" | "uncapped";
  squad: BestSquadPlayer[];
  predicted_pts: number | null;
  actual_pts: number | null;
  scored: boolean;
};
/** Per-position calibration learned from past accuracy, applied to future projections. */
export type Calibration = { position: string; n_gws: number; multiplier: number };

/** A player row enriched with rules-v1 projection data for the explorer table. */
export type PlayerRow = {
  fpl_id: number;
  web_name: string;
  position: Position | null;
  now_cost: number | null; // tenths of a million
  selected_by_percent: number | null;
  total_points: number | null; // last completed season
  status: string | null;
  team: { short_name: string; name: string } | null;
  team_id: number | null;
  xp_next: number | null; // projected xPts, next GW
  xp5: number | null; // projected xPts summed over the next 5 GWs
  opp: string | null; // next-GW opponent short code ("HUL" home, "@HUL" away)
  opp_fdr: number | null; // custom FDR of that fixture (1 easy .. 5 hard)
  components: BreakdownComponent[] | null; // next-GW xPts breakdown
  schedule: ScheduleItem[] | null; // per-GW projection over the horizon
  news: NewsSignal | null; // advisory news/sentiment signal, if any recent news
};
