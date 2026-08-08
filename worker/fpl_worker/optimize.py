"""Squad + transfer optimizer — HiGHS MILP (spec §3.3).

Two modes:
  --fresh      pick the best 15 from scratch within £100m (what your team *could* be).
  --transfers  start from YOUR current squad + bank + free transfers, and find the transfers
               that maximise projected xPts over the horizon NET of -4 hits (a move is only
               made if its gain beats the hit). This is the default.

Both maximise projected points over the 5-GW horizon subject to FPL rules (2/5/5/3, <=3 per
club, valid formation, captain). Results are written to optimizer_runs; the web reads them.
Selling price is approximated by current price (exact preseason). Multi-week sequencing and
chip timing are the next upgrade.

    python -m fpl_worker.optimize --transfers
"""

from __future__ import annotations

import argparse
from collections import defaultdict

import highspy
from dotenv import load_dotenv

from . import db
from .model import MODEL_VERSION

BUDGET = 1000  # £100.0m in tenths of a million
SQUAD_QUOTA = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
FORMATION_MIN = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
FORMATION_MAX = {"GK": 1, "DEF": 5, "MID": 5, "FWD": 3}
EXCLUDE_STATUS = {"i", "s", "u", "n"}
BENCH_WEIGHT = 0.1
HIT_COST = 4


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
    players = (
        sb.table("players")
        .select("fpl_id, web_name, position, team_id, now_cost, status")
        .execute()
        .data
    )
    teams = sb.table("teams").select("fpl_id, short_name").execute().data
    short_by_id = {t["fpl_id"]: t["short_name"] for t in teams}

    projs = _fetch_all_projections(sb)
    next_gw = min(p["gw"] for p in projs)
    xp5: dict[int, float] = defaultdict(float)
    xpn: dict[int, float] = {}
    for r in projs:
        xp5[r["player_id"]] += r["x_pts"] or 0.0
        if r["gw"] == next_gw:
            xpn[r["player_id"]] = r["x_pts"] or 0.0

    pool = []
    for p in players:
        if p["status"] in EXCLUDE_STATUS or p["position"] not in SQUAD_QUOTA or p["now_cost"] is None:
            continue
        pool.append(_entry(p, short_by_id, xp5, xpn, is_current=False))
    return pool, next_gw, short_by_id, dict(xp5), xpn


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


def _slim(p: dict) -> dict:
    return {
        "fpl_id": p["fpl_id"],
        "web_name": p["web_name"],
        "position": p["position"],
        "team_short": p["team_short"],
        "now_cost": p.get("now_cost", p.get("cost")),
        "xp5": p["xp5"],
    }


def _current_state(sb):
    rows = (
        sb.table("user_team_state").select("*").eq("user_id", "me")
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
    }


def _print_squad(squad: list[dict], captain: dict | None) -> None:
    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    for p in sorted([s for s in squad if s["is_start"]], key=lambda x: (order[x["position"]], -x["xp5"])):
        c = " (C)" if p["is_captain"] else ""
        print(f"  {p['position']:3} {p['web_name'][:16]:17}{p['team_short']:4} £{p['now_cost']/10:<5} xp5={p['xp5']}{c}")
    print("  Bench: " + ", ".join(f"{p['web_name']}({p['team_short']})" for p in squad if not p["is_start"]))


def run_fresh(sb) -> None:
    pool, next_gw, _, _, _ = load_pool(sb)
    print(f"Fresh-squad optimize over {len(pool)} players (GW{next_gw}) ...")
    res = _solve(pool, BUDGET, current_count=0, free_transfers=15)
    squad = res["squad"]
    captain = next((p for p in squad if p["is_captain"]), None)
    _print_squad(squad, captain)
    _write_run(sb, next_gw, squad, captain, transfers=None, gain=None, objective="max_xpts_5gw_fresh")


def run_transfers(sb) -> None:
    pool, next_gw, short_by_id, xp5_by_id, xpn_by_id = load_pool(sb)
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
    print(f"Transfer optimize (GW{next_gw}, FT={'∞' if ft is None else free_transfers}) over {len(universe)} players ...")

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
    _write_run(sb, next_gw, squad, captain, transfers=transfers, gain=gain, objective="max_xpts_5gw_transfers")


def _write_run(sb, gw, squad, captain, transfers, gain, objective) -> None:
    sb.table("optimizer_runs").delete().eq("user_id", "me").execute()
    sb.table("optimizer_runs").insert(
        {
            "user_id": "me",
            "gw": gw,
            "horizon": 5,
            "objective": objective,
            "suggested_squad": squad,
            "transfers": transfers,
            "chip_reco": None,
            "captain_id": captain["fpl_id"] if captain else None,
            "expected_gain": gain,
        }
    ).execute()
    print("\nWrote optimizer_runs.")


def main() -> None:
    parser = argparse.ArgumentParser(description="FPL squad + transfer optimizer (HiGHS MILP).")
    parser.add_argument("--fresh", action="store_true", help="best 15 from scratch")
    parser.add_argument("--transfers", action="store_true", help="best transfers from your squad (default)")
    args = parser.parse_args()
    load_dotenv()
    sb = db.get_client()
    if args.fresh:
        run_fresh(sb)
    else:
        run_transfers(sb)


if __name__ == "__main__":
    main()
