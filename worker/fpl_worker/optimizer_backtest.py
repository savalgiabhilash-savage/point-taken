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
With --chips, each GW also runs the live chip plan (optimize._chip_plan) and plays the recommended chip
when its best GW arrives: Triple Captain (captain x3), Bench Boost (bench scores), Free Hit (one-week squad,
then back), Wildcard (the rebuilt squad is kept). One of each per half (GW1-19, GW20-38); FTs are kept.
Without it, transfer settings are judged on their own. The dataset has no injury
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

from . import backtest, optimize, risk

CUBE = Path(".cache") / "optcube"
H_MAX = 19  # look-ahead projections per deadline (19 covers the rest of a half, for CHIP_SCAN)
TOP_SHRINK: tuple[float, float] | None = None  # (t, k): above t keep k of the excess (--top-shrink)
GRID = {"DECAY": [0.8, 0.9, 1.0], "BENCH_WEIGHT": [0.05, 0.1, 0.2], "HIT_COST": [4, 6]}
BENCH_GRID = {"BENCH_WEIGHT_GK": [0.0, 0.03, 0.1], "BENCH_WEIGHT": [0.1, 0.2, 0.3]}  # --bench-grid


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


def _with_roles(squad: list[dict], xp: dict[int, float]) -> list[dict]:
    """Vice-captain = best other starter, bench ordered GK first then by projection (as optimize.squad_at)."""
    out = [dict(p) for p in squad]
    starters = sorted((p for p in out if p["is_start"] and not p["is_captain"]), key=lambda p: -xp.get(p["fpl_id"], 0))
    for p in out:
        p["is_vice"] = bool(starters) and p is starters[0]
    bench = sorted((p for p in out if not p["is_start"]), key=lambda p: (p["position"] != "GK", -xp.get(p["fpl_id"], 0)))
    for k, p in enumerate(bench, 1):
        p["bench_order"] = k
    return out


def _autosub_score(squad: list[dict], pts: dict[int, float], mins: dict[int, float], chip: str | None = None) -> float:
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
    if chip == "Bench Boost":  # all 15 score, no subs needed
        xi = squad
    total = sum(pts.get(p["fpl_id"], 0) for p in xi if played(p))
    cap = next((p for p in squad if p["is_captain"]), None)
    vice = next((p for p in squad if p.get("is_vice")), None)
    extra = 2 if chip == "Triple Captain" else 1
    if cap and played(cap):
        total += extra * pts.get(cap["fpl_id"], 0)
    elif vice and played(vice):
        total += extra * pts.get(vice["fpl_id"], 0)
    return total


def _apply_risk(xp_by_gw: dict, rounds, profile: str, own: dict, pos: dict) -> None:
    """Replace projections for `rounds` with the profile's value (risk.py). Past seasons have no simulated
    ranges, so floor and ceiling come from risk.fitted_range; no start chances, so Safe's rotation rule is
    live-only."""
    if profile == "balanced":
        return
    for e, by in xp_by_gw.items():
        for r in rounds:
            if r in by:
                p10, p90 = risk.fitted_range(by[r], pos.get(e, "MID"))
                by[r] = risk.value(by[r], p10, p90, own.get(e, 0.0), None, profile)


def simulate(season: str, horizon: int = 5, verbose: bool = False, chips: bool = False, profile: str = "balanced") -> dict:
    """One season following the optimizer with the current module settings. Returns points and hits."""
    df = backtest.load_season(season)
    cube = projection_cube(season)
    g_rows = df.groupby(["element", "round"]).agg(
        pts=("total_points", "sum"), mins=("minutes", "sum"), value=("value", "first"),
        pos=("pos", "first"), team=("team", "first"), name=("name", "first"),
        selected=("selected", "first")).reset_index()
    rounds = sorted(int(r) for r in df["round"].unique())
    squad: list[dict] = []
    buy_price: dict[int, int] = {}
    bank, ft, total, hits_total, log = 1000, 15, 0.0, 0, []
    held: set[str] = set()
    played_chips: list[tuple[int, str, float]] = []
    for g in rounds:
        if g in (rounds[0], optimize.CHIP_HALF_END + 1):
            held = {"Triple Captain", "Bench Boost", "Wildcard", "Free Hit"}  # a fresh set each half
        now = g_rows[g_rows["round"] == g].set_index("element")
        gws = [r for r in rounds if g <= r < g + horizon]
        c = cube[(cube["asof"] == g) & (cube["round"].isin(gws))]
        if TOP_SHRINK:  # test a monotone top-end correction on the projections the optimizer sees
            t, k = TOP_SHRINK
            c = c.assign(pred=c["pred"].where(c["pred"] <= t, t + k * (c["pred"] - t)))
        xp_by_gw: dict[int, dict[int, float]] = {}
        for e, r, v in c[["element", "round", "pred"]].itertuples(index=False):
            xp_by_gw.setdefault(int(e), {})[int(r)] = xp_by_gw.get(int(e), {}).get(int(r), 0.0) + float(v)
        price = now["value"].to_dict()
        managers = max(1.0, now["selected"].sum() / 15.0) if "selected" in now else 1.0
        own = (now["selected"] / managers).to_dict() if "selected" in now else {}
        _apply_risk(xp_by_gw, gws, profile, own, now["pos"].to_dict())

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
                                    time_limit=120.0)  # generous, so a busy machine doesn't change the plan
        step = plan["path"][0]
        new = plan["gw0_squad"]
        chip, gw_squad = None, None
        if chips and g != rounds[0]:
            codes = [optimize.CHIP_CODES[c] for c in held]
            scan = None
            if optimize.CHIP_SCAN:  # later GWs of this half the cube has projections for (made at this deadline)
                half_end = optimize.CHIP_HALF_END if g <= optimize.CHIP_HALF_END else optimize.LAST_GW
                scan = [r for r in rounds if gws[-1] < r <= half_end and r < g + H_MAX]
                for e, r, v in cube[(cube["asof"] == g) & (cube["round"].isin(scan))][["element", "round", "pred"]].itertuples(index=False):
                    xp_by_gw.setdefault(int(e), {})[int(r)] = xp_by_gw.get(int(e), {}).get(int(r), 0.0) + float(v)
                _apply_risk(xp_by_gw, scan, profile, own, now["pos"].to_dict())
            cp = optimize._chip_plan(plan["plan_squads"], plan["hits_by_gw"], universe, budget, xp_by_gw, gws, codes,
                                     frees_by_gw=[step["free"] for step in plan["path"]], scan_gws=scan)
            best = cp["best"]
            if best and best["gw"] == g and best["chip"] in held:
                chip = best["chip"]
                held.discard(chip)
                xp_now = {e: v.get(g, 0.0) for e, v in xp_by_gw.items()}
                if chip in ("Wildcard", "Free Hit"):
                    opt = next(o for o in best["options"] if o["gw"] == g)
                    meta = {u["fpl_id"]: u for u in universe}
                    rebuilt = _with_roles([{**meta[x["fpl_id"]], "is_start": x["is_start"], "is_captain": x["is_captain"]}
                                           for x in opt["squad"]], xp_now)
                    if chip == "Free Hit":
                        gw_squad = rebuilt          # this GW only; the planned squad continues next week
                        new = squad                 # no transfers this GW; FTs and bank untouched
                        step = {"num": 0, "out": [], "in": []}
                    else:
                        step = {"num": 0, "out": [{"fpl_id": e} for e in owned - {p["fpl_id"] for p in rebuilt}],
                                "in": [{"fpl_id": p["fpl_id"]} for p in rebuilt if p["fpl_id"] not in owned]}
                        new = rebuilt
        for o in step["out"]:
            bank += sell[o["fpl_id"]]
            buy_price.pop(o["fpl_id"], None)
        for i in step["in"]:
            bank -= int(price[i["fpl_id"]])
            buy_price[i["fpl_id"]] = int(price[i["fpl_id"]])
        squad = new
        if chip in ("Wildcard", "Free Hit"):
            hits = 0                                  # free rebuild; banked FTs are kept
        else:
            hits = 0 if g == rounds[0] else max(0, step["num"] - ft)
            ft = 1 if g == rounds[0] else min(optimize.FT_CAP, max(ft - step["num"], 0) + 1)
        scored = gw_squad or squad
        gw_pts = (_autosub_score(scored, now["pts"].to_dict(), now["mins"].to_dict(), chip)
                  - 4 * hits)  # FPL's real hit, whatever HIT_COST the plan used
        if chip:
            played_chips.append((g, chip, gw_pts))
        total += gw_pts
        hits_total += hits
        log.append((g, step["num"], hits, gw_pts))
        if verbose:
            print(f"    GW{g}: {step['num']} transfers, {hits} hits, {gw_pts:.0f} pts (bank {bank})"
                  + (f" [{chip}]" if chip else ""), flush=True)
    gw_pts = [x[3] for x in log]
    return {"season": season, "points": total, "hits": hits_total, "transfers": sum(x[1] for x in log[1:]),
            "chips": played_chips, "big": sum(p >= 80 for p in gw_pts), "poor": sum(p <= 40 for p in gw_pts)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay seasons following the transfer optimizer.")
    parser.add_argument("--seasons", nargs="+", default=["2023-24", "2024-25", "2025-26"])
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--grid", action="store_true", help="run every combination in GRID")
    parser.add_argument("--bench-grid", action="store_true", help="run every combination in BENCH_GRID")
    parser.add_argument("--chips", action="store_true", help="play chips as the live chip plan recommends")
    parser.add_argument("--chip-scales", nargs="+", type=float, default=[1.0],
                        help="with --chips: multiply every chip's bar (CHIP_THRESHOLDS) by each value in turn")
    parser.add_argument("--top-shrink", nargs=2, type=float, metavar=("T", "K"), help="test a top-end shrink")
    parser.add_argument("--risk", choices=risk.PROFILES, default="balanced",
                        help="plan with a risk profile (risk.py): its values and hit cost")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    global TOP_SHRINK
    TOP_SHRINK = tuple(args.top_shrink) if args.top_shrink else None
    for s in args.seasons:
        projection_cube(s)
    grid = GRID if args.grid else BENCH_GRID if args.bench_grid else None
    combos = [dict(zip(grid, v)) for v in itertools.product(*grid.values())] if grid else [{}]
    base_bars = dict(optimize.CHIP_THRESHOLDS)
    for combo in combos:
        for k, v in combo.items():
            setattr(optimize, k, v)
        for scale in (args.chip_scales if args.chips else [1.0]):
            optimize.CHIP_THRESHOLDS = {k: v * scale for k, v in base_bars.items()}
            t = time.time()
            optimize.HIT_COST = risk.HIT_COST[args.risk]
            res = [simulate(s, args.horizon, args.verbose, args.chips, args.risk) for s in args.seasons]
            label = " ".join(f"{k}={v}" for k, v in combo.items()) or "current settings"
            label += f" risk={args.risk}" if args.risk != "balanced" else ""
            if args.chips:
                label += f" chip bars x{scale}"
            print(f"{label} H={args.horizon}: " + " | ".join(
                f"{r['season']} {r['points']:.0f} pts ({r['transfers']} transfers, {r['hits']} hits, "
                f"{r['big']} GWs 80+, {r['poor']} GWs 40-)" for r in res)
                + f" | total {sum(r['points'] for r in res):.0f} [{time.time() - t:.0f}s]", flush=True)
            for r in res:
                if r["chips"]:
                    print(f"    {r['season']} chips: " + ", ".join(f"GW{g} {c} {p:.0f}" for g, c, p in r["chips"]), flush=True)


if __name__ == "__main__":
    main()
