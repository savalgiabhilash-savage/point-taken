import { chipStatus, type ChipVerdictInput } from "@/lib/chips";
import { createServerSupabase } from "@/lib/supabase/server";

// FPL's availability flag in words, so the assistant never reads a code (or a low projection) as an injury.
const AVAIL: Record<string, string> = {
  a: "available (no injury flag)", d: "doubtful (flagged)", i: "injured (flagged)", s: "suspended",
  u: "unavailable (left club / on loan)", n: "not in squad",
};
const availability = (s: string | null | undefined) => AVAIL[s ?? ""] ?? s ?? "unknown";
import { MODEL_VERSION } from "@/lib/supabase";

// Tools the grounded assistant can call. Each reads live data from Supabase and returns compact
// JSON — the model may only cite what these return, never invent numbers.
const r1 = (n: number) => Math.round(n * 10) / 10;

type SB = Awaited<ReturnType<typeof createServerSupabase>>;

async function nextGw(sb: SB): Promise<number | null> {
  const { data } = await sb
    .from("projections")
    .select("gw")
    .eq("model_version", MODEL_VERSION)
    .order("gw", { ascending: true })
    .limit(1);
  return data?.[0]?.gw ?? null;
}

async function projForGw(sb: SB, gw: number): Promise<Map<number, number>> {
  const { data } = await sb
    .from("projections")
    .select("player_id, x_pts")
    .eq("model_version", MODEL_VERSION)
    .eq("gw", gw)
    .range(0, 999);
  const m = new Map<number, number>();
  for (const row of data ?? []) m.set(row.player_id, row.x_pts ?? 0);
  return m;
}

export const TOOLS = [
  {
    name: "list_top_players",
    description:
      "List the highest projected-points (xPts) players for the upcoming gameweek, optionally filtered by position, max price, or minimum ownership. Use this for 'best players', 'budget picks', captaincy shortlists, and transfer targets.",
    input_schema: {
      type: "object",
      properties: {
        position: { type: "string", enum: ["GK", "DEF", "MID", "FWD"], description: "Filter to one position" },
        max_price: { type: "number", description: "Maximum price in £m, e.g. 8.0" },
        min_ownership: { type: "number", description: "Minimum ownership %, e.g. 10" },
        limit: { type: "integer", description: "How many to return (default 10)" },
      },
    },
  },
  {
    name: "get_player",
    description:
      "Look up one player by name: their projected xPts (next GW and next 5 GWs), price, ownership, availability status, and any recent news/sentiment. Use for questions about a specific player.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Player name or partial name" } },
      required: ["name"],
    },
  },
  {
    name: "get_my_team",
    description:
      "Get the user's current 15-man squad with each player's projected xPts, plus their bank and free transfers. Use for any question about the user's own team.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_optimizer_plan",
    description:
      "Get the optimizer's recommendation for the user's team: recommended captain, this-week transfers, the multi-week transfer path, chip timing, and expected points gain. Use this for 'what should I do', transfers, hits, and chip questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_best_xi",
    description:
      "Get the best possible XI for the upcoming gameweek, either within a £100m budget ('capped') or with no budget ('uncapped'). Use for 'best team this week' / 'dream team' questions.",
    input_schema: {
      type: "object",
      properties: { variant: { type: "string", enum: ["capped", "uncapped"], description: "Default 'capped'" } },
    },
  },
];

export async function runTool(name: string, input: unknown, userId = "me"): Promise<unknown> {
  const sb = await createServerSupabase();
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === "list_top_players") {
    const gw = await nextGw(sb);
    if (gw == null) return { error: "No projections available yet." };
    const proj = await projForGw(sb, gw);
    const { data: players } = await sb
      .from("players")
      .select("fpl_id, web_name, position, now_cost, selected_by_percent, status, team:teams(short_name)");
    let rows = (players ?? []).map((p) => ({
      name: p.web_name,
      team: (p.team as { short_name?: string } | null)?.short_name ?? "?",
      position: p.position,
      price: r1((p.now_cost ?? 0) / 10),
      ownership: p.selected_by_percent,
      availability: availability(p.status),
      xpts_next: r1(proj.get(p.fpl_id) ?? 0),
    }));
    const pos = args.position as string | undefined;
    const maxPrice = args.max_price as number | undefined;
    const minOwn = args.min_ownership as number | undefined;
    if (pos) rows = rows.filter((r) => r.position === pos);
    if (typeof maxPrice === "number") rows = rows.filter((r) => r.price <= maxPrice);
    if (typeof minOwn === "number") rows = rows.filter((r) => (r.ownership ?? 0) >= minOwn);
    rows.sort((a, b) => b.xpts_next - a.xpts_next);
    return { gameweek: gw, players: rows.slice(0, (args.limit as number) ?? 10) };
  }

  if (name === "get_player") {
    const q = String(args.name ?? "").trim();
    if (!q) return { error: "No name given." };
    const { data: matches } = await sb
      .from("players")
      .select("fpl_id, web_name, position, now_cost, selected_by_percent, status, team:teams(short_name)")
      .ilike("web_name", `%${q}%`)
      .order("selected_by_percent", { ascending: false })
      .limit(10);
    if (!matches?.length) return { error: `No player found matching "${q}".` };
    // Several players can share a name (two Palmers): prefer an exact name match, then the most-owned,
    // and tell the model about the others so it can ask or switch.
    const p = matches.find((m) => m.web_name.toLowerCase() === q.toLowerCase()) ?? matches[0];
    const others = matches
      .filter((m) => m.fpl_id !== p.fpl_id)
      .map((m) => `${m.web_name} (${(m.team as { short_name?: string } | null)?.short_name ?? "?"}, £${r1((m.now_cost ?? 0) / 10)}m)`);
    const gw = await nextGw(sb);
    const proj = gw != null ? await projForGw(sb, gw) : new Map<number, number>();
    const { data: allProj } = gw != null
      ? await sb
          .from("projections")
          .select("x_pts")
          .eq("model_version", MODEL_VERSION)
          .eq("player_id", p.fpl_id)
          .gte("gw", gw)
          .lt("gw", gw + 5)
      : { data: [] as { x_pts: number | null }[] };
    const xp5 = r1((allProj ?? []).reduce((s, x) => s + (x.x_pts ?? 0), 0));
    const { data: news } = await sb
      .from("news_sentiment")
      .select("sentiment, topics, summary, minutes_risk_adj")
      .eq("player_id", p.fpl_id)
      .order("published_at", { ascending: false })
      .limit(1);
    return {
      name: p.web_name,
      team: (p.team as { short_name?: string } | null)?.short_name ?? "?",
      position: p.position,
      price: r1((p.now_cost ?? 0) / 10),
      ownership: p.selected_by_percent,
      availability: availability(p.status),
      xpts_next: r1(proj.get(p.fpl_id) ?? 0),
      xpts_next5: xp5,
      news: news?.[0] ?? null,
      other_matches: others.length ? others : undefined,
    };
  }

  if (name === "get_my_team") {
    const { data: st } = await sb
      .from("user_team_state")
      .select("*")
      .eq("user_id", userId)
      .order("gw", { ascending: false })
      .limit(1);
    const team = st?.[0];
    if (!team?.picks) return { error: "No team has been synced yet." };
    const gw = await nextGw(sb);
    const proj = gw != null ? await projForGw(sb, gw) : new Map<number, number>();
    const ids = (team.picks as { element: number }[]).map((p) => p.element);
    const { data: players } = await sb
      .from("players")
      .select("fpl_id, web_name, position, now_cost, status, team:teams(short_name)")
      .in("fpl_id", ids);
    const byId = new Map((players ?? []).map((p) => [p.fpl_id, p]));
    const squad = (team.picks as { element: number; position: number; is_captain?: boolean }[]).map((pick) => {
      const p = byId.get(pick.element);
      return {
        name: p?.web_name ?? String(pick.element),
        team: (p?.team as { short_name?: string } | null)?.short_name ?? "?",
        position: p?.position,
        price: r1((p?.now_cost ?? 0) / 10),
        xpts_next: r1(proj.get(pick.element) ?? 0),
        availability: availability(p?.status),
        starting: pick.position <= 11,
        is_captain: !!pick.is_captain,
      };
    });
    return {
      gameweek: gw,
      bank: r1((team.bank ?? 0) / 10),
      free_transfers: team.free_transfers,
      squad,
    };
  }

  if (name === "get_optimizer_plan") {
    const { data } = await sb
      .from("optimizer_runs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    const run = data?.[0];
    if (!run) return { error: "No optimizer run available yet." };
    const t = (run.transfers ?? {}) as Record<string, unknown>;
    const squad = (run.suggested_squad ?? []) as { web_name: string; is_captain?: boolean }[];
    return {
      gameweek: run.gw,
      recommended_captain: squad.find((p) => p.is_captain)?.web_name ?? null,
      expected_gain_pts: run.expected_gain,
      chip_recommendation: run.chip_reco,
      this_week_transfers: (t.num as number) ?? 0,
      transfers_out: ((t.out as { web_name: string }[]) ?? []).map((p) => p.web_name),
      transfers_in: ((t.in as { web_name: string }[]) ?? []).map((p) => p.web_name),
      // The app's chip verdict (lib/chips.ts): the same call the Optimizer, Chips and This week screens show.
      // The user's play style (Safe / Balanced / Bold) the plan was made with, and its cost vs Balanced.
      play_style: (t.risk as { profile?: string } | undefined)?.profile ?? "balanced",
      play_style_cost: t.risk ?? null,
      chip_this_gw: (t.chip_now as string | null | undefined) ?? null,
      chip_schedule: ((t.chips as (ChipVerdictInput & { gain: number; gw_type?: string })[]) ?? []).map((c) => ({
        chip: c.chip,
        status: chipStatus(c), // now = play this GW · planned = play in planned_gw, not now · hold · used
        planned_gw: c.plan_gw ?? null,
        week_shown: c.gw,
        gain: c.gain,
        gameweek_type: c.gw_type || "single",
      })),
      transfer_path: ((t.path as { gw: number; num: number; hits: number }[]) ?? []).map((s) => ({
        gw: s.gw,
        transfers: s.num,
        hits: s.hits,
      })),
    };
  }

  if (name === "get_best_xi") {
    const variant = (args.variant as string) === "uncapped" ? "uncapped" : "capped";
    const { data } = await sb
      .from("gw_predictions")
      .select("*")
      .eq("variant", variant)
      .eq("scored", false)
      .order("gw", { ascending: false })
      .limit(1);
    const pred = data?.[0];
    if (!pred) return { error: "No best-XI prediction available yet." };
    const squad = (pred.squad ?? []) as { web_name: string; position: string; xpn: number; now_cost: number; is_start: boolean; is_captain: boolean }[];
    return {
      gameweek: pred.gw,
      variant,
      predicted_pts: pred.predicted_pts,
      cost: r1(squad.reduce((s, p) => s + p.now_cost, 0) / 10),
      captain: squad.find((p) => p.is_captain)?.web_name ?? null,
      starting_xi: squad
        .filter((p) => p.is_start)
        .map((p) => ({ name: p.web_name, position: p.position, xpts: r1(p.xpn), price: r1(p.now_cost / 10) })),
    };
  }

  return { error: `Unknown tool: ${name}` };
}
