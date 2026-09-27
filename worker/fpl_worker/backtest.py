"""Backtest harness: replay the xPts model over past seasons and score it against what happened.

Accuracy plan step 0 (blueprint section 17): no model change counts as an improvement unless it
improves these numbers. For every gameweek g of a past season, the model is rebuilt from ONLY what
was known before g's deadline — the previous season's totals plus this season's data up to g-1 —
and its prediction for g is compared with the points actually scored. FPL's own expected points at
the time (`xP` in the dataset) are scored the same way as the benchmark to beat.

It calls the production model functions (nailedness, player_rates, project_fixture, the team
blend, DefCon), so any change to model.py / fdr.py is measured automatically.

Data: the public vaastav/Fantasy-Premier-League dataset (per-player, per-fixture rows with FPL's
own xG/xA/xGC, minutes, starts, points and xP), downloaded once and cached under .cache/vaastav.

Known differences from live running (read the results with these in mind):
  * No injury/suspension flags exist in the dataset, so every player is treated as available.
    FPL's xP does know about injuries — so the "played" subset (minutes > 0) is also reported,
    which compares the two on points given that the player appeared.
  * "Last season" attacking and team data come from FPL's xG (Opta) instead of Understat.
  * No calibration multiplier and no World Cup form factor (identity).
  * DefCon points only exist from 2025/26, so earlier seasons project zero DefCon (their rules).
  * The dataset's xP column is broken for 2025/26 (mean 0.34 vs 1.17 actual points; earlier seasons
    track actual closely), so xP is checked per season and dropped where it doesn't line up. The
    head-to-head scope "vs_xP" only covers seasons where the benchmark is valid.

    python -m fpl_worker.backtest                          # 2023-24, 2024-25, 2025-26
    python -m fpl_worker.backtest --seasons 2025-26 --from-gw 4
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from datetime import date
from pathlib import Path

import pandas as pd

from . import fdr, model

BASE_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
CACHE = Path(".cache") / "vaastav"
REPORTS = Path(__file__).resolve().parent.parent / "reports"
DEFAULT_SEASONS = ["2023-24", "2024-25", "2025-26"]
POSITIONS = {"GK": "GK", "GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}  # drops "AM" rows
ELEMENT_TYPE = {"GK": 1, "DEF": 2, "MID": 3, "FWD": 4}
DEFCON_FROM_SEASON = "2025-26"
TOP_K = 20
XP_VALID_RATIO = 0.6  # a season's mean xP must be at least 60% of mean actual points to be a usable benchmark


# --- data ---------------------------------------------------------------------

def _csv(season: str, path: str) -> pd.DataFrame:
    """Download a dataset file once, then read it from the local cache."""
    local = CACHE / season / path.replace("/", "_")
    if not local.exists():
        local.parent.mkdir(parents=True, exist_ok=True)
        pd.read_csv(f"{BASE_URL}/{season}/{path}").to_csv(local, index=False)
    return pd.read_csv(local)


def _prev(season: str) -> str:
    a, b = season.split("-")
    return f"{int(a) - 1}-{int(b) - 1:02d}"


def load_season(season: str) -> pd.DataFrame:
    """Per-player, per-fixture rows with a stable cross-season `code` and a clean position."""
    gw = _csv(season, "gws/merged_gw.csv")
    raw = _csv(season, "players_raw.csv")[["id", "code"]].rename(columns={"id": "element"})
    df = gw.merge(raw, on="element", how="left")
    df["pos"] = df["position"].map(POSITIONS)
    df = df[df["pos"].notna()].copy()
    for col in ("expected_goals", "expected_assists", "expected_goals_conceded", "defensive_contribution",
                "yellow_cards", "starts", "minutes", "total_points", "xP"):
        if col not in df:
            df[col] = 0.0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    df["was_home"] = df["was_home"].astype(str).str.lower().eq("true")
    return df


def teams(season: str) -> pd.DataFrame:
    return _csv(season, "teams.csv")[["id", "name"]]


# --- priors from the previous season -----------------------------------------

def last_season_priors(prev: pd.DataFrame) -> tuple[dict, dict]:
    """(player totals by code, team per-game xG by name) from the previous season — the backtest's
    stand-in for the live model's Understat 2025/26 baseline."""
    players = (
        prev.groupby("code")[["expected_goals", "expected_assists", "minutes", "yellow_cards"]].sum()
        .rename(columns={"expected_goals": "xg", "expected_assists": "xa"})
    )
    by_code = {str(c): r._asdict() for c, r in zip(players.index, players.itertuples(index=False))}
    games = prev.groupby("team")["fixture"].nunique()
    xgf = prev.groupby("team")["expected_goals"].sum()
    xgc = prev.groupby("team")["expected_goals_conceded"].sum() / 11.0  # 11 on the pitch share each chance
    team_by_name = {}
    for t in games.index:
        g = games[t]
        team_by_name[t] = {"xgf_pg": xgf[t] / g, "xga_pg": xgc[t] / g, "rating": (xgf[t] - xgc[t]) / g}
    return by_code, team_by_name


# --- one gameweek -------------------------------------------------------------

def predict_gw(df: pd.DataFrame, g: int, season: str, team_list: list[dict], last_players: dict,
               last_teams: dict, base: dict) -> pd.DataFrame:
    """Model predictions for every player-row of GW g, using only rows from GWs before g."""
    past = df[df["round"] < g]
    now = df[df["round"] == g]
    name_to_id = {t["name"]: t["fpl_id"] for t in team_list}

    # This season so far, per player (by element) and per club.
    cur = past.groupby("element")[["minutes", "expected_goals", "expected_assists", "defensive_contribution"]].sum()
    club_games = past.groupby("team")["fixture"].nunique().to_dict()
    team_rows = [
        {"team_id": name_to_id.get(t), "expected_goals": r.expected_goals, "expected_goals_conceded": r.expected_goals_conceded}
        for t, r in past.groupby("team")[["expected_goals", "expected_goals_conceded"]].sum().iterrows()
    ]
    home = past[past["was_home"]].drop_duplicates("fixture").set_index("fixture")["team"]
    away = past[~past["was_home"]].drop_duplicates("fixture").set_index("fixture")["team"]
    fixtures = [{"team_h": name_to_id.get(home[f]), "team_a": name_to_id.get(away[f]), "finished": True}
                for f in home.index.intersection(away.index)]
    ratings = fdr.blend_with_current(last_teams, team_list, team_rows, fixtures)
    team_rt = model.build_team_ratings_by_id(team_list, ratings)
    league_xga = sum(r["xga_pg"] for r in team_rt.values()) / len(team_rt)

    # DefCon per-90 (2025/26 rules onward), from this season's counts so far.
    dc90: dict[int, float] = {}
    if season >= DEFCON_FROM_SEASON:
        els = [{"id": int(e), "element_type": ELEMENT_TYPE[p], "minutes": cur.loc[e, "minutes"] if e in cur.index else 0,
                "defensive_contribution": cur.loc[e, "defensive_contribution"] if e in cur.index else 0}
               for e, p in now.groupby("element")["pos"].first().items()]
        dc90 = model.defcon_rates(els)

    out = []
    for r in now.itertuples(index=False):
        e = r.element
        c = cur.loc[e] if e in cur.index else None
        last = last_players.get(str(r.code)) if pd.notna(r.code) else None
        player = {
            "position": r.pos, "status": "a", "chance_of_playing_next_round": None,
            "minutes": float(c["minutes"]) if c is not None else 0.0,
            "expected_goals": float(c["expected_goals"]) if c is not None else 0.0,
            "expected_assists": float(c["expected_assists"]) if c is not None else 0.0,
        }
        player["nailed"] = model.nailedness(player["minutes"], int(club_games.get(r.team, 0)),
                                            last["minutes"] if last else None)
        rates = model.player_rates(model._observed(last, player), r.pos, base)
        rates["dc90"] = dc90.get(int(e), 0.0)
        our_id = name_to_id.get(r.team)
        our = team_rt.get(our_id, {"xgf_pg": 1.3, "xga_pg": 1.4})
        opp = team_rt.get(int(r.opponent_team), our)
        comp = model.project_fixture(player, rates, bool(r.was_home), league_xga, our, opp)
        out.append({"element": e, "round": g, "pos": r.pos, "pred": comp["x_pts"], "p_start": comp["p_start"],
                    "actual": r.total_points, "minutes": r.minutes, "starts": r.starts, "xP": r.xP})
    rows = pd.DataFrame(out)
    # A double gameweek has two rows: sum points and predictions; xP is already the GW total.
    return rows.groupby(["element", "round", "pos"], as_index=False).agg(
        pred=("pred", "sum"), p_start=("p_start", "first"), actual=("actual", "sum"),
        minutes=("minutes", "sum"), starts=("starts", "max"), xP=("xP", "first"))


def run_season(season: str, from_gw: int = 1) -> pd.DataFrame:
    df = load_season(season)
    prev = load_season(_prev(season))
    last_players, last_teams = last_season_priors(prev)
    team_list = [{"fpl_id": int(r.id), "name": r.name} for r in teams(season).itertuples(index=False)]
    # Position base rates (the shrinkage prior) from last season, as the live model does.
    # (compute_base_rates keys players by understat_id; here the stable FPL `code` plays that role)
    prior_players = [{"understat_id": str(code), "position": pos}
                     for code, pos in prev.groupby("code")["pos"].first().items()]
    base = model.compute_base_rates(prior_players, last_players)

    frames = []
    for g in sorted(df["round"].unique()):
        if g < from_gw:
            continue
        frames.append(predict_gw(df, int(g), season, team_list, last_players, last_teams, base))
    res = pd.concat(frames, ignore_index=True)
    res["season"] = season
    ratio = res["xP"].mean() / res["actual"].mean()
    if ratio < XP_VALID_RATIO:
        print(f"  {season}: FPL xP looks broken in the dataset (mean xP is {ratio:.0%} of mean points) — "
              "excluded as a benchmark for this season")
        res["xP"] = float("nan")
    return res


# --- scoring ------------------------------------------------------------------

def _err(pred: pd.Series, actual: pd.Series) -> dict:
    d = pred - actual
    return {"mae": round(d.abs().mean(), 3), "rmse": round(math.sqrt((d ** 2).mean()), 3), "bias": round(d.mean(), 3)}


def score(res: pd.DataFrame) -> dict:
    """Headline metrics for the model and FPL's xP on the same player-gameweeks."""
    out: dict = {"n": int(len(res))}
    for name, col in (("model", "pred"), ("fpl_xP", "xP")):
        if res[col].isna().any():
            out[name] = None  # benchmark unavailable for (part of) this scope
            continue
        m = {"all": _err(res[col], res["actual"])}
        played = res[res["minutes"] > 0]
        m["played"] = _err(played[col], played["actual"])
        m["by_position"] = {p: _err(g[col], g["actual"])["mae"] for p, g in res.groupby("pos")}
        # Ranking: average per-GW Spearman correlation between prediction and points.
        m["spearman"] = round(res.groupby(["season", "round"]).apply(
            lambda g: g[col].rank().corr(g["actual"].rank()), include_groups=False).mean(), 3)  # Spearman
        # Decisions: average points of the top-20 predicted players, and of the top-1 (captain) per GW.
        top = res.sort_values(col, ascending=False).groupby(["season", "round"])
        m["top20_avg_pts"] = round(top.head(TOP_K)["actual"].mean(), 3)
        # How often a top-20 pick didn't play at all (a minutes miss, the costliest error).
        m["top20_no_show"] = round((top.head(TOP_K)["minutes"] == 0).mean(), 3)
        m["captain_avg_pts"] = round(top.head(1)["actual"].mean(), 3)
        out[name] = m
    oracle = res.sort_values("actual", ascending=False).groupby(["season", "round"])
    out["oracle"] = {"top20_avg_pts": round(oracle.head(TOP_K)["actual"].mean(), 3),
                     "captain_avg_pts": round(oracle.head(1)["actual"].mean(), 3)}
    # Minutes: Brier score of the model's P(start) against whether the player started.
    out["model"]["p_start_brier"] = round(((res["p_start"] - (res["starts"] > 0)) ** 2).mean(), 4)
    # Calibration: mean prediction vs mean actual by prediction decile.
    dec = pd.qcut(res["pred"].rank(method="first"), 10, labels=False)
    out["model"]["calibration"] = [
        {"decile": int(d) + 1, "pred": round(g["pred"].mean(), 2), "actual": round(g["actual"].mean(), 2)}
        for d, g in res.groupby(dec)]
    return out


def _report(results: dict) -> str:
    lines = [f"# Backtest — model {model.MODEL_VERSION} vs FPL xP ({date.today().isoformat()})", ""]
    lines.append("| Scope | n | Model MAE | xP MAE | Model MAE (played) | xP MAE (played) | Model ρ | xP ρ "
                 "| Model top-20 | xP top-20 | Oracle top-20 | Model capt | xP capt | P(start) Brier |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    def xv(x, *keys):
        if x is None:
            return "—"
        for k in keys:
            x = x[k]
        return x

    for scope, s in results.items():
        m, x, o = s["model"], s["fpl_xP"], s["oracle"]
        lines.append(f"| {scope} | {s['n']} | {m['all']['mae']} | {xv(x, 'all', 'mae')} | {m['played']['mae']} | "
                     f"{xv(x, 'played', 'mae')} | {m['spearman']} | {xv(x, 'spearman')} | {m['top20_avg_pts']} | "
                     f"{xv(x, 'top20_avg_pts')} | {o['top20_avg_pts']} | {m['captain_avg_pts']} | "
                     f"{xv(x, 'captain_avg_pts')} | {m['p_start_brier']} |")
    head = results.get("vs_xP") or results["all"]
    lines += ["", "Top-20 picks that didn't play (model / xP): " + ", ".join(
        f"{scope} {s['model']['top20_no_show']:.0%} / "
        f"{'—' if s['fpl_xP'] is None else format(s['fpl_xP']['top20_no_show'], '.0%')}" for scope, s in results.items())]
    lines += ["MAE by position (model / xP, head-to-head seasons): " + ", ".join(
        f"{p} {head['model']['by_position'][p]} / {xv(head['fpl_xP'], 'by_position', p)}" for p in ("GK", "DEF", "MID", "FWD"))]
    allr = results["all"]
    lines += [f"Bias (mean pred − actual): model {allr['model']['all']['bias']} (all seasons), "
              f"xP {xv(head['fpl_xP'], 'all', 'bias')} (head-to-head seasons)", "",
              "Calibration (model, all seasons, by prediction decile): " + ", ".join(
                  f"D{c['decile']} {c['pred']}→{c['actual']}" for c in allr["model"]["calibration"])]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest the xPts model against past seasons.")
    parser.add_argument("--seasons", nargs="+", default=DEFAULT_SEASONS)
    parser.add_argument("--from-gw", type=int, default=1, help="skip gameweeks before this one")
    args = parser.parse_args()

    per_season = []
    results = {}
    for s in args.seasons:
        print(f"Replaying {s} ...")
        res = run_season(s, args.from_gw)
        per_season.append(res)
        results[s] = score(res)
    everything = pd.concat(per_season, ignore_index=True)
    valid = everything[everything["xP"].notna()]
    if len(valid) and len(valid) < len(everything):
        results["vs_xP"] = score(valid)  # model and xP on exactly the same player-gameweeks
    results["all"] = score(everything.assign(xP=everything["xP"] if len(valid) == len(everything) else float("nan")))

    report = _report(results)
    print("\n" + report)
    REPORTS.mkdir(exist_ok=True)
    stem = REPORTS / f"backtest_{model.MODEL_VERSION}_{date.today().isoformat()}"
    stem.with_suffix(".md").write_text(report, encoding="utf-8")
    stem.with_suffix(".json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nSaved {stem}.md / .json")


if __name__ == "__main__":
    main()
