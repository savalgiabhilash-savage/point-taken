import type { SupabaseClient } from "@supabase/supabase-js";

// Live gameweek: points so far (FPL's live feed, provisional bonus included) and a projected final score.
// Projected = points so far + the part of the pre-deadline projection (prediction_log) still to be played:
// a game not started keeps its full share, a game in progress keeps the share of its 90 minutes left, a
// finished game adds nothing. Auto-subs and the vice-captain rule are applied to players whose games are all
// finished with 0 minutes, as FPL does at the end of the GW.

const FPL = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 fpl-selector (personal FPL tool)";
const MAX_LEAGUE = 50; // project whole leagues that fit on one standings page
// Bigger private leagues: estimate from the standings page you're on (≈50 managers around your rank). Rivals far
// above or below rarely swap places with you in one GW, so your projected place among them, offset by the
// page's first rank, estimates your league rank. Capped per user to keep FPL API calls down; system leagues
// (Overall, country, club) keep FPL's own ranks.
const MAX_BIG = 3;
const POS = ["", "GK", "DEF", "MID", "FWD"];

async function fpl<T>(path: string, revalidate = 60): Promise<T> {
  const res = await fetch(`${FPL}/${path}`, { headers: { "User-Agent": UA, Accept: "application/json" }, next: { revalidate } });
  if (!res.ok) throw new Error(`FPL ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

type Pick = { element: number; position: number; multiplier: number; is_captain: boolean; is_vice_captain: boolean; element_type: number };
type Picks = { active_chip: string | null; picks: Pick[]; entry_history: { points: number; total_points: number; event_transfers_cost: number; rank: number | null; overall_rank: number | null } };
type Fixture = { id: number; team_h: number; team_a: number; started: boolean; finished: boolean; finished_provisional: boolean; minutes: number };
type LiveEl = { id: number; stats: { minutes: number; total_points: number } };
type Entry = { current_event: number | null; leagues: { classic: { id: number; name: string; league_type: string; entry_rank: number | null; rank_count: number | null }[] } };
type Member = { entry: number; entry_name: string; player_name: string; rank: number };
type Standings = { standings: { results: Member[] } };

export type LivePlayer = {
  id: number; name: string; team: string; pos: string; slot: number; mult: number;
  minutes: number; live: number; proj: number; state: "done" | "playing" | "todo" | "dnp" | "blank";
  subbedOut?: boolean; subbedIn?: boolean;
};
// One manager in a projected league (GW points are net of hits).
export type LeagueRow = {
  entry: number; team: string; manager: string; me: boolean; captain: string; chip: string | null;
  gwLive: number; gwProj: number; totalLive: number; totalProj: number;
};
// Ranks: gw* = this gameweek's points only, live*/proj* = season total. Big leagues carry FPL's own ranks.
export type LiveLeague = {
  id: number; name: string; members: number | null;
  gwLiveRank: number | null; gwProjRank: number | null; liveRank: number | null; projRank: number | null;
  fplGwRank: number | null; fplRank: number | null; leaderGap: number | null; table: LeagueRow[] | null;
  estimated?: boolean; // big league: ranks estimated from the managers around you (table = those managers)
  offset?: number; // estimated leagues: league rank of the manager just above the table's first row
};
export type LiveData = {
  gw: number; status: "upcoming" | "live" | "final"; updatedAt: string;
  live: number; projected: number; hits: number; liveTotal: number; projectedTotal: number;
  players: LivePlayer[]; notes: string[]; leagues: LiveLeague[];
};

// Ctx: per-player facts every squad shares (live points, games left, projection).
type Ctx = {
  live: Map<number, LiveEl["stats"]>;
  fx: Map<number, Fixture[]>; // team -> its fixtures this GW
  team: Map<number, number>; // player -> team
  xp: Map<number, number>;
  // Per game, from the pre-deadline snapshot (prediction_log): expected appearance points and expected minutes
  // (his scoring rate = the rest of his points ÷ his minutes). Missing → the plain share-of-match formula.
  rate: Map<number, { app: number; mins: number }>;
};

// Live, in a game that has kicked off: a player with minutes is on the pitch (or was), one with 0 is on the bench.
const BENCH_ON_P = 0.4; // chance an unused sub still comes on, scaled by the share of the match left
const CAMEO_MIN = 20; // minutes a sub typically gets

function playerState(ctx: Ctx, id: number) {
  const s = ctx.live.get(id) ?? { minutes: 0, total_points: 0 };
  const games = ctx.fx.get(ctx.team.get(id) ?? -1) ?? [];
  const done = (f: Fixture) => f.finished || f.finished_provisional;
  // Points still to come, game by game (a double GW splits the projection evenly).
  //  - not kicked off: the full pre-deadline projection for that game
  //  - in progress, he has minutes (on the pitch): his scoring rate × minutes left, plus the 60' appearance point
  //    if he'll still reach it; without a rate, the projection × share of the match left (old formula)
  //  - in progress, 0 minutes (on the bench): BENCH_ON_P × share left of a CAMEO_MIN-minute cameo
  const perGame = games.length ? (ctx.xp.get(id) ?? 0) / games.length : 0;
  const r = ctx.rate.get(id);
  const ppm = r && r.mins > 0 ? Math.max(0, perGame - r.app) / r.mins : null; // points per minute played
  const rem = games.reduce((a, f) => {
    if (done(f)) return a;
    if (!f.started) return a + perGame;
    const left = Math.max(0, 90 - (f.minutes ?? 0));
    if (ppm == null) return a + (perGame * left) / 90;
    if (s.minutes > 0) return a + ppm * left + (s.minutes < 60 && s.minutes + left >= 60 ? 1 : 0);
    const cameo = Math.min(CAMEO_MIN, left);
    return a + BENCH_ON_P * (left / 90) * (1 + ppm * cameo);
  }, 0);
  const allDone = games.every(done);
  const state: LivePlayer["state"] = !games.length ? "blank"
    : allDone ? (s.minutes > 0 ? "done" : "dnp")
    : games.some((f) => f.started && !done(f)) ? "playing" : "todo";
  return { minutes: s.minutes, live: s.total_points, proj: s.total_points + rem, state, out: state === "dnp" || state === "blank" };
}

// Score one squad: live (as FPL shows now) and projected (with auto-subs / vice-captain applied).
function scoreSquad(ctx: Ctx, p: Picks) {
  const picks = [...p.picks].sort((a, b) => a.position - b.position);
  const st = new Map(picks.map((k) => [k.element, playerState(ctx, k.element)]));
  const live = picks.reduce((a, k) => a + k.multiplier * st.get(k.element)!.live, 0);
  const mult = new Map(picks.map((k) => [k.element, k.multiplier]));
  const subs: [number, number][] = [];
  if (p.active_chip !== "bboost") {
    const xi = picks.filter((k) => k.position <= 11);
    const bench = picks.filter((k) => k.position > 11);
    const count = (t: number) => xi.filter((k) => k.element_type === t).length;
    for (const out of [...xi]) {
      if (!st.get(out.element)!.out) continue;
      const i = bench.findIndex((b) => {
        if (st.get(b.element)!.out) return false;
        if ((out.element_type === 1) !== (b.element_type === 1)) return false; // GK only for GK
        if (out.element_type === b.element_type) return true;
        const min = { 2: 3, 3: 2, 4: 1 }[out.element_type] ?? 0;
        const max = { 2: 5, 3: 5, 4: 3 }[b.element_type] ?? 0;
        return count(out.element_type) - 1 >= min && count(b.element_type) + 1 <= max;
      });
      if (i < 0) continue;
      const [inn] = bench.splice(i, 1);
      xi.splice(xi.indexOf(out), 1, inn);
      mult.set(inn.element, 1);
      mult.set(out.element, 0);
      subs.push([out.element, inn.element]);
    }
    const cap = picks.find((k) => k.is_captain);
    const vice = picks.find((k) => k.is_vice_captain);
    if (cap && vice && st.get(cap.element)!.out && !st.get(vice.element)!.out && xi.includes(vice)) {
      mult.set(vice.element, cap.multiplier);
      if (!xi.includes(cap)) mult.set(cap.element, 0);
    }
  }
  const projected = picks.reduce((a, k) => a + (mult.get(k.element) ?? 0) * st.get(k.element)!.proj, 0);
  const h = p.entry_history;
  const prev = h.total_points - h.points + h.event_transfers_cost; // season total before this GW
  return {
    live, projected, hits: h.event_transfers_cost, subs, st, mult,
    liveTotal: prev + live - h.event_transfers_cost, projectedTotal: prev + projected - h.event_transfers_cost,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]); }
  }));
  return out;
}

const rankOf = (mine: number, all: number[]) => 1 + all.filter((v) => v > mine).length;
const r1 = (v: number) => Math.round(v * 10) / 10;

export async function liveGameweek(sb: SupabaseClient, entryId: number): Promise<LiveData | null> {
  const entry = await fpl<Entry>(`entry/${entryId}/`, 300);
  const gw = entry.current_event;
  if (!gw) return null;
  const [mine, fixtures, liveRes] = await Promise.all([
    fpl<Picks>(`entry/${entryId}/event/${gw}/picks/`),
    fpl<Fixture[]>(`fixtures/?event=${gw}`),
    fpl<{ elements: LiveEl[] }>(`event/${gw}/live/`),
  ]);

  // Rivals in every league small enough to project live (deduped across leagues).
  const small = entry.leagues.classic.filter((l) => (l.rank_count ?? Infinity) <= MAX_LEAGUE);
  const members = await pool(small, 4, (l) =>
    fpl<Standings>(`leagues-classic/${l.id}/standings/`).then((s) => s.standings.results).catch(() => [] as Member[]));
  const big = entry.leagues.classic
    .filter((l) => (l.rank_count ?? 0) > MAX_LEAGUE && l.league_type === "x")
    .sort((a, b) => (a.rank_count ?? 0) - (b.rank_count ?? 0))
    .slice(0, MAX_BIG);
  const windows = await pool(big, 3, (l) =>
    fpl<Standings>(`leagues-classic/${l.id}/standings/?page_standings=${Math.max(1, Math.ceil((l.entry_rank ?? 1) / 50))}`)
      .then((s) => s.standings.results)
      .catch(() => [] as Member[]));
  const rivalIds = [...new Set([...members, ...windows].flat().map((m) => m.entry))].filter((id) => id !== entryId);
  const rivalPicks = new Map<number, Picks>();
  await pool(rivalIds, 8, async (id) => {
    const p = await fpl<Picks>(`entry/${id}/event/${gw}/picks/`).catch(() => null);
    if (p?.picks?.length) rivalPicks.set(id, p);
  });

  const ids = [...new Set([mine, ...rivalPicks.values()].flatMap((p) => p.picks.map((k) => k.element)))];
  const [playersRes, xpRes, rateRes, teamsRes] = await Promise.all([
    sb.from("players").select("fpl_id, web_name, team_id").in("fpl_id", ids),
    sb.from("prediction_log").select("player_id, predicted_xp").eq("gw", gw).in("player_id", ids),
    // Separate query: before migration 0014 these columns don't exist, the query fails and live projections
    // fall back to the plain share-of-match formula, while predicted_xp above still loads.
    sb.from("prediction_log").select("player_id, exp_minutes, x_app_pts").eq("gw", gw).in("player_id", ids),
    sb.from("teams").select("fpl_id, short_name"),
  ]);
  const fx = new Map<number, Fixture[]>();
  for (const f of fixtures) for (const t of [f.team_h, f.team_a]) (fx.get(t) ?? fx.set(t, []).get(t)!).push(f);
  const teamOf = new Map((playersRes.data ?? []).map((p) => [p.fpl_id as number, p.team_id as number]));
  const ctx: Ctx = {
    live: new Map(liveRes.elements.map((e) => [e.id, e.stats])),
    fx,
    team: teamOf,
    xp: new Map((xpRes.data ?? []).map((r) => [r.player_id as number, Number(r.predicted_xp ?? 0)])),
    // exp_minutes and x_app_pts cover the whole GW, so a double GW splits them per game like the points.
    rate: new Map(
      (rateRes.data ?? [])
        .filter((r) => r.exp_minutes != null)
        .map((r) => {
          const n = Math.max(1, fx.get(teamOf.get(r.player_id as number) ?? -1)?.length ?? 1);
          return [r.player_id as number, { app: Number(r.x_app_pts ?? 0) / n, mins: Number(r.exp_minutes) / n }];
        }),
    ),
  };
  const name = new Map((playersRes.data ?? []).map((p) => [p.fpl_id as number, p.web_name as string]));
  const short = new Map((teamsRes.data ?? []).map((t) => [t.fpl_id as number, t.short_name as string]));

  const me = scoreSquad(ctx, mine);
  const rivals = new Map([...rivalPicks].map(([id, p]) => [id, scoreSquad(ctx, p)]));

  const CHIP: Record<string, string> = { bboost: "BB", "3xc": "TC", freehit: "FH", wildcard: "WC" };
  const rowsFor = (list: Member[]): LeagueRow[] =>
    list
      .map((m) => {
        const isMe = m.entry === entryId;
        const r = isMe ? me : rivals.get(m.entry);
        const p = isMe ? mine : rivalPicks.get(m.entry);
        if (!r || !p) return null;
        const cap = p.picks.find((x) => x.is_captain);
        return {
          entry: m.entry, team: m.entry_name, manager: m.player_name, me: isMe,
          captain: cap ? (name.get(cap.element) ?? "?") : "?", chip: p.active_chip ? (CHIP[p.active_chip] ?? p.active_chip) : null,
          gwLive: r.live - r.hits, gwProj: r1(r.projected - r.hits), totalLive: r.liveTotal, totalProj: r1(r.projectedTotal),
        };
      })
      .filter((r) => r != null)
      .sort((a, b) => b.totalProj - a.totalProj);

  const leagues: LiveLeague[] = entry.leagues.classic.map((l) => {
    const k = small.indexOf(l);
    const b = big.indexOf(l);
    if (b >= 0 && windows[b].length) {
      // Estimated: your projected place among the managers on your standings page, offset by its first rank.
      // This GW's rank needs the whole league, so only the season ranks are estimated.
      const table = rowsFor(windows[b]);
      const meRow = table.find((r) => r.me);
      const others = table.filter((r) => !r.me);
      const offset = Math.min(...windows[b].map((m) => m.rank)) - 1;
      if (meRow) {
        return {
          id: l.id, name: l.name, members: l.rank_count, fplGwRank: null, fplRank: l.entry_rank, table, estimated: true, offset,
          gwLiveRank: null, gwProjRank: null,
          liveRank: offset + rankOf(meRow.totalLive, others.map((r) => r.totalLive)),
          projRank: offset + rankOf(meRow.totalProj, others.map((r) => r.totalProj)),
          leaderGap: null,
        };
      }
    }
    if (k < 0) {
      // The game-wide "Overall" league: FPL's own live GW and overall ranks; other big leagues: FPL's last rank.
      const overall = l.name === "Overall";
      return {
        id: l.id, name: l.name, members: l.rank_count, gwLiveRank: null, gwProjRank: null, liveRank: null, projRank: null,
        fplGwRank: overall ? mine.entry_history.rank : null,
        fplRank: overall ? (mine.entry_history.overall_rank ?? l.entry_rank) : l.entry_rank,
        leaderGap: null, table: null,
      };
    }
    const table = rowsFor(members[k]);
    const others = table.filter((r) => !r.me);
    const meRow = table.find((r) => r.me);
    if (!meRow) return { id: l.id, name: l.name, members: l.rank_count, gwLiveRank: null, gwProjRank: null, liveRank: null, projRank: null, fplGwRank: null, fplRank: l.entry_rank, leaderGap: null, table };
    return {
      id: l.id, name: l.name, members: l.rank_count, fplGwRank: null, fplRank: l.entry_rank, table,
      gwLiveRank: rankOf(meRow.gwLive, others.map((r) => r.gwLive)),
      gwProjRank: rankOf(meRow.gwProj, others.map((r) => r.gwProj)),
      liveRank: rankOf(meRow.totalLive, others.map((r) => r.totalLive)),
      projRank: rankOf(meRow.totalProj, others.map((r) => r.totalProj)),
      leaderGap: others.length ? r1(meRow.totalProj - Math.max(...others.map((r) => r.totalProj))) : null,
    };
  });

  const done = (f: Fixture) => f.finished || f.finished_provisional;
  const status = fixtures.every(done) ? "final" : fixtures.some((f) => f.started) ? "live" : "upcoming";

  const players: LivePlayer[] = [...mine.picks].sort((a, b) => a.position - b.position).map((k) => {
    const s = me.st.get(k.element)!;
    const sub = me.subs.find(([o, i]) => o === k.element || i === k.element);
    return {
      id: k.element, name: name.get(k.element) ?? "?", team: short.get(ctx.team.get(k.element) ?? -1) ?? "",
      pos: POS[k.element_type], slot: k.position, mult: me.mult.get(k.element) ?? 0,
      minutes: s.minutes, live: s.live, proj: Math.round(s.proj * 10) / 10,
      state: s.state,
      subbedOut: sub?.[0] === k.element || undefined, subbedIn: sub?.[1] === k.element || undefined,
    };
  });

  const notes: string[] = me.subs.map(([o, i]) => `Auto-sub: ${name.get(i) ?? "?"} on for ${name.get(o) ?? "?"} (didn't play)`);
  const cap = mine.picks.find((k) => k.is_captain);
  const vice = mine.picks.find((k) => k.is_vice_captain);
  if (cap && vice && (me.mult.get(vice.element) ?? 0) > 1) notes.push(`${name.get(vice.element)} takes the armband: ${name.get(cap.element)} didn't play`);
  if (mine.active_chip) notes.push(`Chip active: ${({ bboost: "Bench Boost", "3xc": "Triple Captain", freehit: "Free Hit", wildcard: "Wildcard" } as Record<string, string>)[mine.active_chip] ?? mine.active_chip}`);

  return {
    gw, status, updatedAt: new Date().toISOString(),
    live: me.live, projected: r1(me.projected), hits: me.hits,
    liveTotal: me.liveTotal, projectedTotal: r1(me.projectedTotal),
    players, notes, leagues,
  };
}
