"""Optimizer backtest: replay whole past seasons with the live transfer optimizer and score real points.

The xPts backtest (backtest.py) asks "are the projections accurate?". This asks the decision question:
"following the optimizer's transfers every week, how many points would a team actually have scored?",
so its settings (DECAY, BENCH_WEIGHT, the cost a hit is charged in the objective, the horizon) can be
tuned on outcomes rather than intuition.

For every gameweek g of a past season:
  1. Projections for GWs g .. g+H-1 using only data before g's deadline (backtest.predict_gw with asof=g;
     odds only for the next GW, as live). Cached per season under .cache/optcube.
  2. The live multi-week MILP (optimize._solve_path) plans from the current squad, bank and free
     transfers; only GW g's moves are made (re-planned next week, as you would).
  3. Prices follow the dataset's weekly `value`; selling price = purchase + half the rise (rounded down).
  4. Scoring is FPL's: starters' actual points, auto-subs in bench order (formation kept legal), captain
     doubled (vice if the captain didn't play), -4 per hit. Free transfers roll over (cap 5).
Chips are not played here, so transfer settings are judged on their own. The dataset has no injury
flags, so the optimizer (like the xPts backtest) can pick players who turned out to be injured.

    python -m fpl_worker.optimizer_backtest --seasons 2024-25
    python -m fpl_worker.optimizer_backtest --grid      # the tuning grid in GRID
"""

from __future__ import annotations

import argparse
import itertools
import time
from pathlib import Path

import pandas as pd

from . import backtest, optimize

CUBE = Path(".cache") / "optcube"
H_MAX = 8
GRID = {"DECAY": [0.8, 0.9, 1.0], "BENCH_WEIGHT": [0.05, 0.1, 0.2], "HIT_COST": [4, 6]}


def projection_cube(season: str) -> pd.DataFrame:
    """[element, asof, round, pred]: the projection for `round` as made at `asof`'s deadline."""
    path = CUBE / f"{season}.pkl"
    if path.exists():
        return pd.read_pickle(path)
    df, team_list, profiles, base, tm = backtest.season_setup(season)
    rounds = sorted(int(r) for r in df["round"].unique())
    frames = []
    for asof in rounds:
        for g in [r for r in rounds if asof <= r < asof + H_MAX]:
            p = backtest.predict_gw(df, g, season, team_list, profiles, base, tm, asof=asof)
            frames.append(p[["element", "pred"]].assign(asof=asof, round=g))
        print(f"  {season}: projections made at GW{asof}", flush=True)
    cube = pd.concat(frames, ignore_index=True)
    CUBE.mkdir(parents=True, exist_ok=True)
    cube.to_pickle(path)
    return cube


def _legal(xi: list[dict]) -> bool:
    n = {P: sum(1 for x in xi if x["position"] == P) for P in ("GK", "DEF", "MID", "FWD")}
    return n["GK"] == 1 and n["DEF"] >= 3 and n["MID"] >= 2 and n["FWD"] >= 1


def _autosub_score(squad: list[dict], pts: dict[int, float], mins: dict[int, float]) -> float:
    """FPL scoring of a 15: each starter who didn't play is replaced by the first bench player (in bench
    order) who played and keeps the formation legal; captain x2, or the vice if the captain didn't play."""
    xi = [p for p in squad if p["is_start"]]
    bench = sorted((p for p in squad if not p["is_start"]), key=lambda p: p.get("bench_order", 9))
    played = lambda p: mins.get(p["fpl_id"], 0) > 0  # noqa: E731
    used: set[int] = set()
    for out in [p for p in xi if not played(p)]:
        for b in bench:
            if b["fpl_id"] in used or not played(b):
                continue
            trial = [x for x in xi if x is not out] + [b]
            if _legal(trial):
                xi, used = trial, used | {b["fpl_id"]}
                break
    total = sum(pts.get(p["fpl_id"], 0) for p in xi if played(p))
    cap = next((p for p in squad if p["is_captain"]), None)
    vice = next((p for p in squad if p.get("is_vice")), None)
    if cap and played(cap):
        total += pts.get(cap["fpl_id"], 0)
    elif vice and played(vice):
        total += pts.get(vice["fpl_id"], 0)
    return total


def simulate(season: str, horizon: int = 5, verbose: bool = False) -> dict:
    """One season following the optimizer with the current module settings. Returns points and hits."""
    df = backtest.load_season(season)
    cube = projection_cube(season)
    g_rows = df.groupby(["element", "round"]).agg(
        pts=("total_points", "sum"), mins=("minutes", "sum"), value=("value", "first"),
        pos=("pos", "first"), team=("team", "first"), name=("name", "first")).reset_index()
    rounds = sorted(int(r) for r in df["round"].unique())
    squad: list[dict] = []
    buy_price: dict[int, int] = {}
    bank, ft, total, hits_total, log = 1000, 15, 0.0, 0, []
    for g in rounds:
        now = g_rows[g_rows["round"] == g].set_index("element")
        gws = [r for r in rounds if g <= r < g + horizon]
        c = cube[(cube["asof"] == g) & (cube["round"].isin(gws))]
        xp_by_gw: dict[int, dict[int, float]] = {}
        for e, r, v in c[["element", "round", "pred"]].itertuples(index=False):
            xp_by_gw.setdefault(int(e), {})[int(r)] = xp_by_gw.get(int(e), {}).get(int(r), 0.0) + float(v)
        price = now["value"].to_dict()

        def entry(e: int, cost: int, current: bool) -> dict:
            r = now.loc[e] if e in now.index else g_rows[g_rows["element"] == e].iloc[-1]
            return {"fpl_id": e, "web_name": r["name"], "position": r["pos"], "team_id": r["team"],
                    "team_short": str(r["team"])[:3], "cost": int(cost), "xp5": 0.0, "xpn": 0.0, "is_current": current}

        owned = {p["fpl_id"] for p in squad}
        sell = {}
        for e in owned:
            cur = int(price.get(e, buy_price[e]))
            sell[e] = buy_price[e] + (cur - buy_price[e]) // 2 if cur > buy_price[e] else cur
        current = [entry(e, sell[e], True) for e in owned]
        pool = [entry(int(e), int(price[e]), False) for e in now.index if int(e) not in owned]
        optimize._set_horizon_xp(current + pool, xp_by_gw, gws)
        universe = optimize._bounded_universe(current, pool)
        budget = sum(sell.values()) + bank
        plan = optimize._solve_path(universe, budget, owned, ft, gws, xp_by_gw, ft_unlimited=(g == rounds[0]),
                                    time_limit=20.0)
        step = plan["path"][0]
        new = plan["gw0_squad"]
        for o in step["out"]:
            bank += sell[o["fpl_id"]]
            buy_price.pop(o["fpl_id"], None)
        for i in step["in"]:
            bank -= int(price[i["fpl_id"]])
            buy_price[i["fpl_id"]] = int(price[i["fpl_id"]])
        squad = new
        hits = 0 if g == rounds[0] else max(0, step["num"] - ft)
        ft = 1 if g == rounds[0] else min(optimize.FT_CAP, max(ft - step["num"], 0) + 1)
        gw_pts = _autosub_score(squad, now["pts"].to_dict(), now["mins"].to_dict()) - 4 * hits  # FPL's real hit, whatever HIT_COST the plan used
        total += gw_pts
        hits_total += hits
        log.append((g, step["num"], hits, gw_pts))
        if verbose:
            print(f"    GW{g}: {step['num']} transfers, {hits} hits, {gw_pts:.0f} pts (bank {bank})", flush=True)
    return {"season": season, "points": total, "hits": hits_total, "transfers": sum(x[1] for x in log[1:])}


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay seasons following the transfer optimizer.")
    parser.add_argument("--seasons", nargs="+", default=["2023-24", "2024-25", "2025-26"])
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--grid", action="store_true", help="run every combination in GRID")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    for s in args.seasons:
        projection_cube(s)
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())] if args.grid else [{}]
    for combo in combos:
        for k, v in combo.items():
            setattr(optimize, k, v)
        t = time.time()
        res = [simulate(s, args.horizon, args.verbose) for s in args.seasons]
        label = " ".join(f"{k}={v}" for k, v in combo.items()) or "current settings"
        print(f"{label} H={args.horizon}: " + " | ".join(
            f"{r['season']} {r['points']:.0f} pts ({r['transfers']} transfers, {r['hits']} hits)" for r in res)
            + f" | total {sum(r['points'] for r in res):.0f} [{time.time() - t:.0f}s]", flush=True)


if __name__ == "__main__":
    main()
