"""Squad + transfer + chip optimizer — HiGHS MILP (spec §3.3).

Modes:
  --fresh      pick the best 15 from scratch within budget (what your team *could* be).
  --transfers  single-deadline: best transfers from your squad, valued over the horizon, −4 hits.
  --plan       (default) FULL multi-week + chip optimizer:
                 * a joint MILP over the whole horizon that plans a transfer PATH — which GW to
                   make each move, when to roll a free transfer, and when a −4 hit is worth taking
                   (free transfers roll over, capped at 5; budget = squad value + bank);
                 * transparent chip-timing for Triple Captain / Bench Boost / Wildcard / Free Hit,
                   each scanning the horizon for its best gameweek and expected point gain.

All modes respect FPL rules (2/5/5/3, ≤3 per club, valid formation, captain). Selling price is
approximated by current price (exact preseason). Results are written to optimizer_runs; the web reads them.

    python -m fpl_worker.optimize --plan
"""

from __future__ import annotations

import argparse
from collections import defaultdict

import highspy
from dotenv import load_dotenv

from . import db
from .model import MODEL_VERSION

BUDGET = 1000  # £100.0m in tenths of a million (used by --fresh)
SQUAD_QUOTA = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
FORMATION_MIN = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
FORMATION_MAX = {"GK": 1, "DEF": 5, "MID": 5, "FWD": 3}
EXCLUDE_STATUS = {"i", "s", "u", "n"}
BENCH_WEIGHT = 0.1
HIT_COST = 4
FT_CAP = 5              # 2026/27: free transfers accumulate up to 5
DECAY = 0.9            # discount future GWs in the objective (uncertainty grows with distance)
POOL_SIZE = 90         # candidate players beyond your current squad (keeps the MILP tractable)
# A chip is recommended only if its MARGINAL gain (vs playing normally with your free transfers)
# clears a per-chip bar — set so ordinary single-gameweek plays don't fire. Chips are saved for
# Double/Blank gameweeks, where a Bench Boost / Triple Captain haul or a Free Hit swing is large.
CHIP_THRESHOLDS = {"Triple Captain": 12.0, "Bench Boost": 18.0, "Wildcard": 8.0, "Free Hit": 8.0}

# Map our chip display names to FPL's internal codes (as they appear in chips_available).
CHIP_CODES = {"Triple Captain": "3xc", "Bench Boost": "bboost", "Wildcard": "wildcard", "Free Hit": "freehit"}


def _fetch_all_projections(sb) -> list[dict]:
    size, out, frm = 1000, [], 0
    while True:
        batch = (
            sb.table("projections").select("player_id, gw, x_pts")
            .eq("model_version", MODEL_VERSION).range(frm, frm + size - 1).execute().data
        )
        out.extend(batch)
        if len(batch) < size:
            return out
        frm += size


def load_pool(sb):
    """Returns (pool, gws, short_by_id, xp5_by_id, xpn_by_id, xp_by_gw).

    xp_by_gw[player_id][gw] is the per-gameweek projection — the raw material the multi-week
    solver and the chip evaluators need."""
    players = (
        sb.table("players")
        .select("fpl_id, web_name, position, team_id, now_cost, status")
        .execute()
        .data
    )
    teams = sb.table("teams").select("fpl_id, short_name").execute().data
    short_by_id = {t["fpl_id"]: t["short_name"] for t in teams}

    projs = _fetch_all_projections(sb)
    gws = sorted({r["gw"] for r in projs})
    next_gw = gws[0] if gws else None
    xp_by_gw: dict[int, dict[int, float]] = defaultdict(dict)
    xp5: dict[int, float] = defaultdict(float)
    xpn: dict[int, float] = {}
    for r in projs:
        v = r["x_pts"] or 0.0
        xp_by_gw[r["player_id"]][r["gw"]] = v
        xp5[r["player_id"]] += v
        if r["gw"] == next_gw:
            xpn[r["player_id"]] = v

    pool = []
    for p in players:
        if p["status"] in EXCLUDE_STATUS or p["position"] not in SQUAD_QUOTA or p["now_cost"] is None:
            continue
        pool.append(_entry(p, short_by_id, xp5, xpn, is_current=False))
    return pool, gws, short_by_id, dict(xp5), xpn, {k: dict(v) for k, v in xp_by_gw.items()}


def _entry(p: dict, short_by_id, xp5, xpn, is_current: bool) -> dict:
    return {
        "fpl_id": p["fpl_id"],
        "web_name": p["web_name"],
        "position": p["position"],
        "team_id": p["team_id"],
        "team_short": short_by_id.get(p["team_id"], "?"),
        "cost": p["now_cost"],  # buy price for pool, sell price for current (approx)
        "xp5": round(xp5.get(p["fpl_id"], 0.0), 3),
        "xpn": round(xpn.get(p["fpl_id"], 0.0), 3),
        "is_current": is_current,
    }


def _bounded_universe(current: list[dict], pool: list[dict], k: int = POOL_SIZE) -> list[dict]:
    """Your current squad + the top-k other players by horizon xPts. Bounds the MILP size."""
    have = {c["fpl_id"] for c in current}
    extra = sorted((p for p in pool if p["fpl_id"] not in have), key=lambda p: -p["xp5"])[:k]
    return current + extra


# --- valid best XI (formation-aware), used by the chip evaluators --------------

def _best_xi(players: list[dict]) -> tuple[float, list[dict], list[dict]]:
    """Given 15 players (each with 'position' and 'xp'), pick the highest-scoring legal XI.
    Returns (xi_value, starters, bench). Enumerates the 8 valid outfield shapes."""
    byp = {P: sorted((p for p in players if p["position"] == P), key=lambda x: -x["xp"]) for P in SQUAD_QUOTA}
    if not byp["GK"]:
        return 0.0, [], players
    gk = byp["GK"][:1]
    best: tuple[float, list[dict]] | None = None
    for d in range(3, 6):
        for m in range(2, 6):
            for f in range(1, 4):
                if d + m + f != 10:
                    continue
                if len(byp["DEF"]) < d or len(byp["MID"]) < m or len(byp["FWD"]) < f:
                    continue
                xi = gk + byp["DEF"][:d] + byp["MID"][:m] + byp["FWD"][:f]
                val = sum(p["xp"] for p in xi)
                if best is None or val > best[0]:
                    best = (val, xi)
    if best is None:
        return 0.0, [], players
    val, xi = best
    xi_ids = {p["fpl_id"] for p in xi}
    bench = [p for p in players if p["fpl_id"] not in xi_ids]
    return val, xi, bench


def _owned_at_gw(owned: list[dict], xp_by_gw: dict, gw: int) -> list[dict]:
    return [
        {"position": o["position"], "fpl_id": o["fpl_id"], "web_name": o["web_name"],
         "xp": xp_by_gw.get(o["fpl_id"], {}).get(gw, 0.0)}
        for o in owned
    ]


def _gw_flags(sb, gws) -> dict[int, dict]:
    """Classify each gameweek by its fixture schedule → {gw: {"type": "DGW"|"BGW"|"", "n": int}}.

    A **Double GW** is one where some clubs play twice (n = how many double); a **Blank GW** is one
    where some clubs have no fixture (n = how many blank). This is what makes chip timing
    fixture-aware: Bench Boost / Triple Captain want a DGW (more of your players play), Free Hit
    wants a BGW (your normal squad is short of starters). Preseason the schedule is all single
    fixtures, so every GW is "" — the flags light up once the season's DGWs/BGWs are announced
    (fixtures move for cup ties). The projections themselves already sum both legs of a DGW, so the
    gains react automatically; these flags make the *reason* explicit in the recommendation."""
    fx = sb.table("fixtures").select("gw, team_h, team_a, finished").execute().data
    all_teams = set()
    for f in fx:
        for k in ("team_h", "team_a"):
            if f[k]:
                all_teams.add(f[k])
    n_teams = len(all_teams) or 20
    flags: dict[int, dict] = {}
    for gw in gws:
        cnt: dict[int, int] = defaultdict(int)
        for f in fx:
            if f["gw"] == gw and not f["finished"]:
                for k in ("team_h", "team_a"):
                    if f[k]:
                        cnt[f[k]] += 1
        if not cnt:
            flags[gw] = {"type": "", "n": 0}
            continue
        doubling = sum(1 for c in cnt.values() if c >= 2)
        blanking = n_teams - len(cnt)
        if doubling:
            flags[gw] = {"type": "DGW", "n": doubling}
        elif blanking > 0:
            flags[gw] = {"type": "BGW", "n": blanking}
        else:
            flags[gw] = {"type": "", "n": 0}
    return flags


# --- single-squad MILP (used by --fresh, --transfers, and the chip evaluators) --

def _solve(universe: list[dict], budget: int, current_count: int, free_transfers: int) -> dict:
    """Core MILP over `universe` (each entry has cost/xp5/xpn/position/team_id/is_current)."""
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    n = len(universe)
    squad = [h.addBinary() for _ in range(n)]
    start = [h.addBinary() for _ in range(n)]
    cap = [h.addBinary() for _ in range(n)]

    pos = [u["position"] for u in universe]
    cost = [u["cost"] for u in universe]
    val = [u["xp5"] for u in universe]
    vnext = [u["xpn"] for u in universe]
    team = [u["team_id"] for u in universe]
    cur = [1 if u["is_current"] else 0 for u in universe]

    h.addConstr(sum(squad[i] for i in range(n)) == 15)
    h.addConstr(sum(cost[i] * squad[i] for i in range(n)) <= budget)
    for P, q in SQUAD_QUOTA.items():
        h.addConstr(sum(squad[i] for i in range(n) if pos[i] == P) == q)
    for t in set(team):
        idxs = [i for i in range(n) if team[i] == t]
        if len(idxs) > 3:
            h.addConstr(sum(squad[i] for i in idxs) <= 3)
    for i in range(n):
        h.addConstr(start[i] <= squad[i])
        h.addConstr(cap[i] <= start[i])
    h.addConstr(sum(start[i] for i in range(n)) == 11)
    for P in SQUAD_QUOTA:
        s = sum(start[i] for i in range(n) if pos[i] == P)
        h.addConstr(s >= FORMATION_MIN[P])
        h.addConstr(s <= FORMATION_MAX[P])
    h.addConstr(sum(cap[i] for i in range(n)) == 1)

    # transfers = current players sold = current_count - (current players kept).
    # paid (>=0) absorbs transfers beyond the free allowance; penalised so it sits at max(0, ...).
    paid = h.addVariable(0, 15)
    kept = sum(squad[i] for i in range(n) if cur[i])
    h.addConstr(paid >= current_count - kept - free_transfers)

    h.maximize(
        sum(val[i] * start[i] for i in range(n))
        + sum(vnext[i] * cap[i] for i in range(n))
        + BENCH_WEIGHT * sum(val[i] * (squad[i] - start[i]) for i in range(n))
        - HIT_COST * paid
    )
    if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
        raise RuntimeError(f"optimizer status: {h.getModelStatus()}")

    picked = []
    for i in range(n):
        if round(h.val(squad[i])) == 1:
            picked.append(
                {
                    **{k: universe[i][k] for k in ("fpl_id", "web_name", "position", "team_short", "cost", "xp5", "xpn", "is_current")},
                    "now_cost": universe[i]["cost"],
                    "is_start": round(h.val(start[i])) == 1,
                    "is_captain": round(h.val(cap[i])) == 1,
                }
            )
    return {"squad": picked, "paid": round(h.val(paid))}


# --- multi-week transfer-path MILP --------------------------------------------

def _solve_path(universe, budget, current_ids, ft0, gws, xp_by_gw, ft_unlimited=False, time_limit=120.0):
    """Joint MILP across the whole horizon: choose the squad, XI, captain, and transfers for
    EVERY gameweek at once, so the solver decides *when* to transfer, *when* to roll a free
    transfer, and *when* a −4 hit pays off. Free transfers roll over (cap FT_CAP); each GW's
    squad must be affordable within `budget` (= your squad value + bank)."""
    H = len(gws)
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("time_limit", time_limit)
    h.setOptionValue("mip_rel_gap", 0.01)
    n = len(universe)
    ids = [u["fpl_id"] for u in universe]
    pos = [u["position"] for u in universe]
    cost = [u["cost"] for u in universe]
    team = [u["team_id"] for u in universe]
    init = [1 if ids[i] in current_ids else 0 for i in range(n)]
    xp = [[xp_by_gw.get(ids[i], {}).get(g, 0.0) for g in gws] for i in range(n)]

    own = [[h.addBinary() for _ in range(H)] for _ in range(n)]
    start = [[h.addBinary() for _ in range(H)] for _ in range(n)]
    cap = [[h.addBinary() for _ in range(H)] for _ in range(n)]
    # buy/sell can be continuous in [0,1]: the squad transitions (integer) force them integral.
    buy = [[h.addVariable(0, 1) for _ in range(H)] for _ in range(n)]
    sell = [[h.addVariable(0, 1) for _ in range(H)] for _ in range(n)]
    free = [h.addVariable(1, 15) for _ in range(H)]  # free transfers available going into GW g
    pen = [h.addVariable(0, 15) for _ in range(H)]        # paid (hit) transfers at GW g

    teams = set(team)
    for g in range(H):
        h.addConstr(sum(own[i][g] for i in range(n)) == 15)
        h.addConstr(sum(cost[i] * own[i][g] for i in range(n)) <= budget)
        for P, q in SQUAD_QUOTA.items():
            h.addConstr(sum(own[i][g] for i in range(n) if pos[i] == P) == q)
        for t in teams:
            idxs = [i for i in range(n) if team[i] == t]
            if len(idxs) > 3:
                h.addConstr(sum(own[i][g] for i in idxs) <= 3)
        for i in range(n):
            h.addConstr(start[i][g] <= own[i][g])
            h.addConstr(cap[i][g] <= start[i][g])
        h.addConstr(sum(start[i][g] for i in range(n)) == 11)
        for P in SQUAD_QUOTA:
            s = sum(start[i][g] for i in range(n) if pos[i] == P)
            h.addConstr(s >= FORMATION_MIN[P])
            h.addConstr(s <= FORMATION_MAX[P])
        h.addConstr(sum(cap[i][g] for i in range(n)) == 1)

        # squad transitions: own[g] - own[g-1] = buy - sell (own[-1] = your current squad)
        for i in range(n):
            prev = init[i] if g == 0 else own[i][g - 1]
            h.addConstr(own[i][g] - prev == buy[i][g] - sell[i][g])

        tf = sum(buy[i][g] for i in range(n))     # transfers made this GW (= number bought)
        h.addConstr(pen[g] >= tf - free[g])        # anything over the free allowance is a hit
        if g == 0:
            h.addConstr(free[0] <= ft0)            # your actual FT (or unlimited, preseason)
        elif ft_unlimited and g == 1:
            # Preseason is unlimited only before GW1; the in-season FT clock then starts at 1.
            h.addConstr(free[1] <= 1)
            h.addConstr(free[1] <= FT_CAP)
        else:
            # free transfers actually consumed last GW = tf[g-1] - pen[g-1]; you gain +1 (capped).
            used_prev = sum(buy[i][g - 1] for i in range(n)) - pen[g - 1]
            h.addConstr(free[g] <= free[g - 1] - used_prev + 1)
            h.addConstr(free[g] <= FT_CAP)

    obj = (
        sum(DECAY ** g * (xp[i][g] * start[i][g] + xp[i][g] * cap[i][g]
                          + BENCH_WEIGHT * xp[i][g] * (own[i][g] - start[i][g]))
            for i in range(n) for g in range(H))
        - HIT_COST * sum(pen[g] for g in range(H))
    )
    h.maximize(obj)

    status = h.getModelStatus()
    if status not in (highspy.HighsModelStatus.kOptimal, highspy.HighsModelStatus.kTimeLimit):
        raise RuntimeError(f"path optimizer status: {status}")

    def squad_at(g):
        out = []
        for i in range(n):
            if round(h.val(own[i][g])) == 1:
                u = universe[i]
                out.append({
                    **{k: u[k] for k in ("fpl_id", "web_name", "position", "team_short", "cost", "xp5", "xpn", "is_current")},
                    "now_cost": u["cost"],
                    "is_start": round(h.val(start[i][g])) == 1,
                    "is_captain": round(h.val(cap[i][g])) == 1,
                })
        return out

    path, xi_by_gw, cap_by_gw, hits_total = [], [], [], 0
    for g in range(H):
        ins = [_slim(universe[i]) for i in range(n) if round(h.val(buy[i][g])) == 1]
        outs = [_slim(universe[i]) for i in range(n) if round(h.val(sell[i][g])) == 1]
        hits_g = round(h.val(pen[g]))
        hits_total += hits_g
        xi_g = sum(xp[i][g] for i in range(n) if round(h.val(start[i][g])) == 1)
        cap_g = sum(xp[i][g] for i in range(n) if round(h.val(cap[i][g])) == 1)
        xi_by_gw.append(round(xi_g, 2))
        cap_by_gw.append(round(cap_g, 2))
        path.append({
            "gw": gws[g],
            "in": ins,
            "out": outs,
            "num": len(ins),
            "hits": hits_g,
            "free": round(h.val(free[g])),
            "xi": round(xi_g + cap_g, 2),  # XI incl. captain double
        })
    planned_pts = round(sum(xi_by_gw) + sum(cap_by_gw) - HIT_COST * hits_total, 1)
    plan_squads = [squad_at(g) for g in range(H)]  # the 15 owned each GW along the planned path
    hits_by_gw = [step["hits"] for step in path]
    return {"gw0_squad": plan_squads[0], "path": path, "hits_total": hits_total,
            "planned_pts": planned_pts, "plan_squads": plan_squads, "hits_by_gw": hits_by_gw}


# --- chip timing --------------------------------------------------------------
# Every chip is valued as its MARGINAL gain over playing normally: the baseline is the squad you
# would actually field that week along the planned transfer path (which already spends your free
# transfers), NOT a frozen "do nothing" squad. That is the fix for the nonsense "Wildcard in GW1"
# result — preseason your normal transfers are already unlimited/free, so a Wildcard adds ~0.

def _plan_val_at(squad15, xp_by_gw, gw):
    """Value of a 15-man squad in one gameweek: best legal XI + captain (the extra ×1), and the
    bench total. Every chip comparison uses this so they are apples-to-apples."""
    val, xi, bench = _best_xi(_owned_at_gw(squad15, xp_by_gw, gw))
    cap = max(xi, key=lambda p: p["xp"]) if xi else None
    return {
        "xi_cap": val + (cap["xp"] if cap else 0.0),  # XI incl. the captain doubling
        "bench": sum(p["xp"] for p in bench),
        "cap": cap["xp"] if cap else 0.0,             # the captain's points = the extra ×1 a TC adds
        "cap_name": cap["web_name"] if cap else None,
    }


def _chip_triple_captain(plan_squads, xp_by_gw, gws):
    best = None
    for gi, g in enumerate(gws):
        v = _plan_val_at(plan_squads[gi], xp_by_gw, g)
        gain = round(v["cap"], 2)  # a TC turns the ×2 captain into ×3 → the extra is one more ×1
        if best is None or gain > best["gain"]:
            best = {"chip": "Triple Captain", "gw": g, "gain": gain,
                    "detail": f"captain {v['cap_name']} projects {v['cap']:.1f} pts"}
    return best


def _chip_bench_boost(plan_squads, xp_by_gw, gws):
    best = None
    for gi, g in enumerate(gws):
        v = _plan_val_at(plan_squads[gi], xp_by_gw, g)
        gain = round(v["bench"], 2)  # BB scores your 4 bench players too
        if best is None or gain > best["gain"]:
            best = {"chip": "Bench Boost", "gw": g, "gain": gain,
                    "detail": "your bench projects the most in this gameweek"}
    return best


def _chip_wildcard(plan_squads, hits_by_gw, universe, budget, xp_by_gw, gws):
    """Marginal value of a free full rebuild vs continuing your planned transfers: the extra points
    the rebuild reaches PLUS any hits it saves. ≈0 when your free transfers already reach the
    optimal squad (e.g. preseason, when transfers are unlimited)."""
    best = None
    for gi, g in enumerate(gws):
        window = gws[gi:]
        uni = [{**u, "xp5": sum(xp_by_gw.get(u["fpl_id"], {}).get(w, 0.0) for w in window),
                "xpn": xp_by_gw.get(u["fpl_id"], {}).get(g, 0.0)} for u in universe]
        fresh = _solve(uni, budget, current_count=0, free_transfers=15)["squad"]
        fresh_val = sum(_plan_val_at(fresh, xp_by_gw, w)["xi_cap"] for w in window)
        plan_val = sum(_plan_val_at(plan_squads[gj], xp_by_gw, gws[gj])["xi_cap"] for gj in range(gi, len(gws)))
        hits_saved = sum(hits_by_gw[gj] for gj in range(gi, len(gws)))
        gain = round(fresh_val - plan_val + HIT_COST * hits_saved, 2)
        if best is None or gain > best["gain"]:
            detail = (f"a free rebuild adds {gain:.1f} pts over your planned transfers for the next "
                      f"{len(window)} GW{'s' if len(window) != 1 else ''}"
                      if gain > 1.0 else "your free transfers already reach the optimal squad — no edge from wildcarding")
            best = {"chip": "Wildcard", "gw": g, "gain": gain, "detail": detail}
    return best


def _chip_free_hit(plan_squads, universe, budget, xp_by_gw, gws):
    """Marginal value of a one-week optimal squad vs the team you'd actually field that GW. Large
    in a Blank GW (when your squad has few players); ≈0 when your squad is already near-optimal."""
    best = None
    for gi, g in enumerate(gws):
        uni = [{**u, "xp5": xp_by_gw.get(u["fpl_id"], {}).get(g, 0.0),
                "xpn": xp_by_gw.get(u["fpl_id"], {}).get(g, 0.0)} for u in universe]
        fh = _solve(uni, budget, current_count=0, free_transfers=15)["squad"]
        gain = round(_plan_val_at(fh, xp_by_gw, g)["xi_cap"] - _plan_val_at(plan_squads[gi], xp_by_gw, g)["xi_cap"], 2)
        if best is None or gain > best["gain"]:
            detail = (f"a one-week squad beats your team by {gain:.1f} here"
                      if gain > 1.0 else "your team is already near-optimal this week — no edge from a Free Hit")
            best = {"chip": "Free Hit", "gw": g, "gain": gain, "detail": detail}
    return best


def _chip_plan(plan_squads, hits_by_gw, universe, budget, xp_by_gw, gws, chips_available, gw_flags=None):
    chips = [
        _chip_triple_captain(plan_squads, xp_by_gw, gws),
        _chip_bench_boost(plan_squads, xp_by_gw, gws),
        _chip_wildcard(plan_squads, hits_by_gw, universe, budget, xp_by_gw, gws),
        _chip_free_hit(plan_squads, universe, budget, xp_by_gw, gws),
    ]
    # Respect which chips you still hold (preseason: chips_available is None -> all available).
    avail = set(chips_available) if chips_available else None
    gw_flags = gw_flags or {}
    for c in chips:
        c["available"] = avail is None or CHIP_CODES[c["chip"]] in avail
        c["threshold"] = CHIP_THRESHOLDS[c["chip"]]
        # Make the chip fixture-aware: tag its best window's schedule type and say so. When a real
        # Double/Blank GW is detected we cite it (that's the ideal week for BB/TC vs FH); otherwise
        # we keep the generic "save it for a DGW/BGW" guidance so preseason advice still reads right.
        fl = gw_flags.get(c["gw"], {"type": "", "n": 0})
        c["gw_type"] = fl["type"]
        if fl["type"] == "DGW":
            c["detail"] += f"; GW{c['gw']} is a Double GW ({fl['n']} clubs play twice)"
        elif fl["type"] == "BGW":
            c["detail"] += f"; GW{c['gw']} is a Blank GW ({fl['n']} clubs have no fixture)"
        elif c["chip"] in ("Triple Captain", "Bench Boost"):
            c["detail"] += "; best saved for a Double GW"
        elif c["chip"] == "Free Hit":
            c["detail"] += "; best saved for a Blank GW"

    # Recommend the chip that most clears its own bar; otherwise hold (the correct default).
    playable = [c for c in chips if c["available"] and c["gain"] >= c["threshold"]]
    best = max(playable, key=lambda c: c["gain"] - c["threshold"]) if playable else None
    if best:
        reco = f"Play {best['chip']} in GW{best['gw']} (+{best['gain']:.1f} xPts) — {best['detail']}."
    else:
        reco = (f"Hold your chips — no window clears the bar over the next {len(gws)} GWs. "
                "Chips are best saved for Double/Blank gameweeks (announced in-season).")
    return {"all": chips, "best": best, "reco": reco}


def _slim(p: dict) -> dict:
    return {
        "fpl_id": p["fpl_id"],
        "web_name": p["web_name"],
        "position": p["position"],
        "team_short": p["team_short"],
        "now_cost": p.get("now_cost", p.get("cost")),
        "xp5": p["xp5"],
    }


def _current_state(sb, user_id="me"):
    rows = (
        sb.table("user_team_state").select("*").eq("user_id", user_id)
        .order("gw", desc=True).limit(1).execute().data
    )
    if not rows or not rows[0]["picks"]:
        return None
    st = rows[0]
    return {
        "ids": [p["element"] for p in st["picks"]],
        "starter_ids": [p["element"] for p in st["picks"] if p["position"] <= 11],
        "bank": st["bank"] or 0,
        "free_transfers": st["free_transfers"],
        "chips_available": st.get("chips_available"),
    }


def _print_squad(squad: list[dict], captain: dict | None) -> None:
    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    for p in sorted([s for s in squad if s["is_start"]], key=lambda x: (order[x["position"]], -x["xp5"])):
        c = " (C)" if p["is_captain"] else ""
        print(f"  {p['position']:3} {p['web_name'][:16]:17}{p['team_short']:4} £{p['now_cost']/10:<5} xp5={p['xp5']}{c}")
    print("  Bench: " + ", ".join(f"{p['web_name']}({p['team_short']})" for p in squad if not p["is_start"]))


def run_fresh(sb) -> None:
    pool, gws, _, _, _, _ = load_pool(sb)
    next_gw = gws[0]
    print(f"Fresh-squad optimize over {len(pool)} players (GW{next_gw}) ...")
    res = _solve(pool, BUDGET, current_count=0, free_transfers=15)
    squad = res["squad"]
    captain = next((p for p in squad if p["is_captain"]), None)
    _print_squad(squad, captain)
    _write_run(sb, next_gw, squad, captain, transfers=None, gain=None,
               objective="max_xpts_5gw_fresh", horizon=len(gws), chip_reco=None)


def run_transfers(sb) -> None:
    pool, gws, short_by_id, xp5_by_id, xpn_by_id, _ = load_pool(sb)
    next_gw = gws[0]
    state = _current_state(sb)
    if not state:
        print("No current squad synced — run sync_team first (or the preseason snapshot).")
        return

    current_ids = set(state["ids"])
    cur_rows = (
        sb.table("players").select("fpl_id, web_name, position, team_id, now_cost")
        .in_("fpl_id", list(current_ids)).execute().data
    )
    current = [_entry(p, short_by_id, xp5_by_id, xpn_by_id, is_current=True) for p in cur_rows]
    universe = current + [p for p in pool if p["fpl_id"] not in current_ids]

    ft = state["free_transfers"]
    free_transfers = 15 if ft is None else max(1, ft)  # None => preseason unlimited
    print(f"Transfer optimize (GW{next_gw}, FT={'inf' if ft is None else free_transfers}) over {len(universe)} players ...")

    res = _solve(universe, BUDGET, current_count=len(current), free_transfers=free_transfers)
    squad = res["squad"]
    paid = res["paid"]
    new_ids = {p["fpl_id"] for p in squad}
    out = [c for c in current if c["fpl_id"] not in new_ids]
    into = [p for p in squad if not p["is_current"]]
    captain = next((p for p in squad if p["is_captain"]), None)

    new_xi = sum(p["xp5"] for p in squad if p["is_start"])
    cur_xi = round(sum(xp5_by_id.get(i, 0.0) for i in state["starter_ids"]), 2)
    gain = round(new_xi - cur_xi - HIT_COST * paid, 2)

    print(f"\nTransfers: {len(out)} (hits paid: {paid}, cost -{HIT_COST * paid})")
    for o, i in zip(out, into):
        print(f"  OUT {o['web_name']:16}({o['team_short']}) xp5={o['xp5']}   ->  IN {i['web_name']:16}({i['team_short']}) xp5={i['xp5']}")
    print(f"\nResulting XI (captain {captain['web_name'] if captain else '?'}):")
    _print_squad(squad, captain)
    print(f"\n  current XI {cur_xi} -> new XI {round(new_xi, 2)}  (net of hits: {gain:+.2f} xPts/5gw)")

    transfers = {
        "out": [_slim(o) for o in out],
        "in": [_slim(i) for i in into],
        "num": len(out),
        "free_transfers": None if ft is None else free_transfers,
        "hits": paid,
        "hit_cost": HIT_COST * paid,
    }
    _write_run(sb, next_gw, squad, captain, transfers=transfers, gain=gain,
               objective="max_xpts_5gw_transfers", horizon=len(gws), chip_reco=None)


def _last_horizon(sb, user_id, default=5):
    """The horizon this user last planned at. There's only ever one optimizer_runs row per user, so
    reading it back makes the choice sticky: the cron and team-change re-runs keep whatever the user
    picked via the Optimizer's "Optimize my squad" control, instead of reverting to the default."""
    try:
        rows = (
            sb.table("optimizer_runs").select("horizon").eq("user_id", user_id)
            .order("created_at", desc=True).limit(1).execute().data
        )
        h = rows[0].get("horizon") if rows else None
        return int(h) if h else default
    except Exception:  # noqa: BLE001 — table/column may be missing; fall back to the default
        return default


def run_plan(sb, user_id="me", horizon=None) -> None:
    pool, all_gws, short_by_id, xp5_by_id, xpn_by_id, xp_by_gw = load_pool(sb)
    if not all_gws:
        print("No projections found — run the model first.")
        return
    state = _current_state(sb, user_id)
    if not state:
        print(f"[{user_id[:8]}] no squad synced — skipping.")
        return

    # Horizon = how many upcoming gameweeks to plan over. Default to the user's last choice; clamp to
    # the gameweeks we actually have projections for.
    if horizon is None:
        horizon = _last_horizon(sb, user_id)
    horizon = max(1, min(int(horizon), len(all_gws)))
    gws = all_gws[:horizon]

    current_ids = set(state["ids"])
    cur_rows = (
        sb.table("players").select("fpl_id, web_name, position, team_id, now_cost")
        .in_("fpl_id", list(current_ids)).execute().data
    )
    current = [_entry(p, short_by_id, xp5_by_id, xpn_by_id, is_current=True) for p in cur_rows]
    owned = [{"fpl_id": c["fpl_id"], "web_name": c["web_name"], "position": c["position"],
              "team_short": c["team_short"]} for c in current]
    universe = _bounded_universe(current, pool)

    budget = sum(c["cost"] for c in current) + state["bank"]
    ft = state["free_transfers"]
    ft0 = 15 if ft is None else max(1, ft)
    print(f"Multi-week plan: {len(gws)} GWs (GW{gws[0]}-{gws[-1]}), FT={'inf' if ft is None else ft0}, "
          f"budget £{budget/10:.1f}m, universe {len(universe)} ...")

    # Give the MILP more time as the horizon grows (a 30-GW plan is a far bigger problem than 5).
    solve_time = min(300.0, 45.0 + 7.0 * len(gws))
    path_res = _solve_path(universe, budget, current_ids, ft0, gws, xp_by_gw,
                           ft_unlimited=(ft is None), time_limit=solve_time)
    squad = path_res["gw0_squad"]
    path = path_res["path"]
    captain = next((p for p in squad if p["is_captain"]), None)

    # Value of the plan vs simply holding your current squad (no transfers) over the horizon.
    hold_pts = 0.0
    for g in gws:
        pls = _owned_at_gw(owned, xp_by_gw, g)
        val, xi, _ = _best_xi(pls)
        cap_xp = max((p["xp"] for p in xi), default=0.0)
        hold_pts += val + cap_xp
    gain = round(path_res["planned_pts"] - hold_pts, 1)

    print(f"\nTransfer path (planned {path_res['planned_pts']} pts vs {round(hold_pts,1)} holding = {gain:+.1f}):")
    for step in path:
        if step["num"] == 0:
            print(f"  GW{step['gw']}: roll (FT banked: {step['free']})")
        else:
            moves = ", ".join(f"{o['web_name']}->{i['web_name']}" for o, i in zip(step["out"], step["in"]))
            hit = f", -{HIT_COST*step['hits']} hit" if step["hits"] else ""
            print(f"  GW{step['gw']}: {step['num']} transfer(s){hit}  [{moves}]")

    # Preseason (no FT set) every chip is available by definition; the synced chip list is
    # unreliable until the season starts, so don't let it suppress a recommendation.
    chips_avail = None if ft is None else state["chips_available"]
    gw_flags = _gw_flags(sb, gws)
    dgw_bgw = [f"GW{g}:{fl['type']}" for g, fl in sorted(gw_flags.items()) if fl["type"]]
    if dgw_bgw:
        print(f"  Fixture flags: {', '.join(dgw_bgw)}")
    chips = _chip_plan(path_res["plan_squads"], path_res["hits_by_gw"], universe, budget, xp_by_gw, gws, chips_avail, gw_flags)
    print("\nChip timing:")
    for c in chips["all"]:
        flag = "" if c["available"] else " (used)"
        print(f"  {c['chip']:15} best GW{c['gw']}  +{c['gain']:.1f}{flag}  — {c['detail']}")
    print(f"  => {chips['reco']}")

    print(f"\nThis week's XI (captain {captain['web_name'] if captain else '?'}):")
    _print_squad(squad, captain)

    immediate = path[0]
    transfers = {
        "out": immediate["out"],
        "in": immediate["in"],
        "num": immediate["num"],
        "free_transfers": None if ft is None else ft0,
        "hits": immediate["hits"],
        "hit_cost": HIT_COST * immediate["hits"],
        "path": path,
        "chips": chips["all"],
        "chip_reco": chips["reco"],
        "planned_pts": path_res["planned_pts"],
        "hold_pts": round(hold_pts, 1),
        # The squad this plan was computed against, so the web can detect when the user's team has
        # changed since (upload/sync) and flag the plan as stale until the next optimize run.
        "based_on": sorted(current_ids),
    }
    _write_run(sb, gws[0], squad, captain, transfers=transfers, gain=gain,
               objective="max_xpts_multiweek", horizon=len(gws), chip_reco=chips["reco"], user_id=user_id)


def _write_run(sb, gw, squad, captain, transfers, gain, objective, horizon=5, chip_reco=None, user_id="me") -> None:
    sb.table("optimizer_runs").delete().eq("user_id", user_id).execute()
    sb.table("optimizer_runs").insert(
        {
            "user_id": user_id,
            "gw": gw,
            "horizon": horizon,
            "objective": objective,
            "suggested_squad": squad,
            "transfers": transfers,
            "chip_reco": chip_reco,
            "captain_id": captain["fpl_id"] if captain else None,
            "expected_gain": gain,
        }
    ).execute()
    print("\nWrote optimizer_runs.")


def _all_user_ids(sb) -> list[str]:
    """The shared "me" demo plus every registered user (profiles) with an FPL entry."""
    ids = ["me"]
    try:
        for p in sb.table("profiles").select("id, fpl_entry_id").execute().data:
            if p.get("fpl_entry_id"):
                ids.append(p["id"])
    except Exception:  # noqa: BLE001 — profiles table may not exist yet
        pass
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(description="FPL squad + transfer + chip optimizer (HiGHS MILP).")
    parser.add_argument("--fresh", action="store_true", help="best 15 from scratch")
    parser.add_argument("--transfers", action="store_true", help="single-deadline transfers (valued over 5 GWs)")
    parser.add_argument("--plan", action="store_true", help="full multi-week transfer path + chip timing (default)")
    parser.add_argument("--horizon", type=int, default=None,
                        help="number of upcoming GWs to plan over (default: the user's last choice, else 5)")
    parser.add_argument("--user", default=None, help="optimize a single user id (default: every user)")
    args = parser.parse_args()
    load_dotenv()
    sb = db.get_client()
    if args.fresh:
        run_fresh(sb)
    elif args.transfers:
        run_transfers(sb)
    else:
        uids = [args.user] if args.user else _all_user_ids(sb)
        for uid in uids:
            run_plan(sb, uid, horizon=args.horizon)


if __name__ == "__main__":
    main()
