"""Backtest harness: replay the xPts model over past seasons and score it against what happened.

Accuracy plan step 0 (blueprint section 17): no model change counts as an improvement unless it
improves these numbers. For every gameweek g of a past season, the model is rebuilt from ONLY what
was known before g's deadline — the previous season's totals plus this season's data up to g-1 —
and its prediction for g is compared with the points actually scored. FPL's own expected points at
the time (`xP` in the dataset) are scored the same way as the benchmark to beat.

It calls the production model functions (minutes_profile, player_rates, project_fixture, DefCon)
and the team goals model (team_model.fit / blend, with that season's market-average odds from
football-data.co.uk), so any change to model.py / team_model.py is measured automatically.

Data: the public vaastav/Fantasy-Premier-League dataset (per-player, per-fixture rows with FPL's
own xG/xA/xGC, minutes, starts, points and xP), downloaded once and cached under .cache/vaastav.

Known differences from live running (read the results with these in mind):
  * No injury/suspension flags exist in the dataset, so every player is treated as available.
    FPL's xP does know about injuries — so the "played" subset (minutes > 0) is also reported,
    which compares the two on points given that the player appeared.
  * "Last season" attacking and team data come from FPL's xG (Opta) instead of Understat.
  * Odds are football-data.co.uk's market averages, collected shortly before each round — about the
    same time the live pipeline reads the upcoming round's odds.
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

from datetime import datetime

from . import model, team_model

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

def last_season_priors(prev: pd.DataFrame) -> dict:
    """Player totals by code from the previous season — the backtest's stand-in for the live model's
    Understat 2025/26 baseline."""
    players = (
        prev.groupby("code")[["expected_goals", "expected_assists", "minutes", "yellow_cards"]].sum()
        .rename(columns={"expected_goals": "xg", "expected_assists": "xa"})
    )
    return {str(c): r._asdict() for c, r in zip(players.index, players.itertuples(index=False))}


def season_matches(df: pd.DataFrame, id_to_name: dict[int, str]) -> list[dict]:
    """Each match's xG per side (sum of that side's players' expected_goals), kickoff date and round —
    the input the team goals model fits on (live: Understat last season + FPL this season)."""
    side = df.groupby(["fixture", "was_home"]).agg(
        team=("team", "first"), opp=("opponent_team", "first"), xg=("expected_goals", "sum"),
        kickoff=("kickoff_time", "first"), round=("round", "first")).reset_index()
    home = side[side["was_home"]].set_index("fixture")
    away = side[~side["was_home"]].set_index("fixture")
    out = []
    for f in home.index.intersection(away.index):
        h, a = home.loc[f], away.loc[f]
        out.append({"home": h["team"], "away": a["team"], "hxg": h["xg"], "axg": a["xg"], "round": int(h["round"]),
                    "date": datetime.fromisoformat(str(h["kickoff"]).replace("Z", "+00:00"))})
    return out


def season_odds(season: str, names: list[str]) -> dict:
    """Market expected goals per (home, away) for a season, from football-data.co.uk (cached)."""
    local = CACHE / season / "football_data_E0.csv"
    if not local.exists():
        local.parent.mkdir(parents=True, exist_ok=True)
        a, b = season.split("-")
        team_model.season_odds(f"{a[2:]}{b}").to_csv(local, index=False)
    return team_model.odds_rows(pd.read_csv(local), names)


# --- one gameweek -------------------------------------------------------------

def predict_gw(df: pd.DataFrame, g: int, season: str, team_list: list[dict], last_players: dict,
               base: dict, tm: dict) -> pd.DataFrame:
    """Model predictions for every player-row of GW g, using only rows from GWs before g."""
    past = df[df["round"] < g]
    now = df[df["round"] == g]
    id_to_name = {t["fpl_id"]: t["name"] for t in team_list}

    # This season so far, per player (by element) and per club.
    cur = past.groupby("element")[["minutes", "expected_goals", "expected_assists", "defensive_contribution"]].sum()
    # Team goals model fitted on last season + this season's matches before GW g, dated at g's first kickoff.
    ref = min(datetime.fromisoformat(str(k).replace("Z", "+00:00")) for k in now["kickoff_time"])
    fitted = [m for m in tm["cur"] if m["round"] < g]
    strengths = team_model.fit(tm["prev"] + fitted, ref, tm["teams"], tm["promoted"])

    # Recent per-GW minutes/starts (last MINUTES_WINDOW GWs), exactly what the live model reads from
    # event/{gw}/live. A player only has rows for GWs his club played, so blanks aren't "dropped".
    recent = past[past["round"] >= g - model.MINUTES_WINDOW]
    per_gw = recent.groupby(["element", "round"]).agg(
        games=("fixture", "size"), starts=("starts", "sum"), minutes=("minutes", "sum")).reset_index()
    history: dict[int, list[dict]] = defaultdict(list)
    for h in per_gw.itertuples(index=False):
        history[h.element].append({"age": (g - 1) - h.round, "games": h.games, "starts": h.starts, "minutes": h.minutes})

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
        player["mprof"] = model.minutes_profile(history.get(e, []), last["minutes"] if last else None)
        rates = model.player_rates(model._observed(last, player), r.pos, base)
        rates["dc90"] = dc90.get(int(e), 0.0)
        opp = id_to_name[int(r.opponent_team)]
        h, a = (r.team, opp) if r.was_home else (opp, r.team)
        lam_h, lam_a = team_model.blend(team_model.model_goals(strengths, h, a), tm["odds"].get((h, a)))
        lam_for, lam_against = (lam_h, lam_a) if r.was_home else (lam_a, lam_h)
        comp = model.project_fixture(player, rates, lam_for, lam_against,
                                     team_model.average_goals_for(strengths, r.team))
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
    last_players = last_season_priors(prev)
    team_list = [{"fpl_id": int(r.id), "name": r.name} for r in teams(season).itertuples(index=False)]
    names = [t["name"] for t in team_list]
    prev_names = list(teams(_prev(season))["name"])
    id_to_name = {t["fpl_id"]: t["name"] for t in team_list}
    prev_id_to_name = {int(r.id): r.name for r in teams(_prev(season)).itertuples(index=False)}
    tm = {
        "prev": season_matches(prev, prev_id_to_name),
        "cur": season_matches(df, id_to_name),
        "teams": sorted(set(names) | set(prev_names)),
        "promoted": set(names) - set(prev_names),
        "odds": season_odds(season, names),
    }
    # Position base rates (the shrinkage prior) from last season, as the live model does.
    # (compute_base_rates keys players by understat_id; here the stable FPL `code` plays that role)
    prior_players = [{"understat_id": str(code), "position": pos}
                     for code, pos in prev.groupby("code")["pos"].first().items()]
    base = model.compute_base_rates(prior_players, last_players)

    frames = []
    for g in sorted(df["round"].unique()):
        if g < from_gw:
            continue
        frames.append(predict_gw(df, int(g), season, team_list, last_players, base, tm))
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
