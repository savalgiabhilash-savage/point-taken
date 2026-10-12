"""Backtest harness: replay the xPts model over past seasons and score it against what happened.

Accuracy plan step 0 (blueprint section 17): no model change counts as an improvement unless it
improves these numbers. For every gameweek g of a past season, the model is rebuilt from ONLY what
was known before g's deadline — the previous season's totals plus this season's data up to g-1 —
and its prediction for g is compared with the points actually scored. FPL's own expected points at
the time (`xP` in the dataset) are scored the same way as the benchmark to beat.

It calls the production model functions (minutes_profile, form_model.form_profile, project_fixture, DefCon)
and the team goals model (team_model.fit / blend, with that season's market-average odds from
football-data.co.uk), so any change to model.py / team_model.py is measured automatically.

Data: the public vaastav/Fantasy-Premier-League dataset (per-player, per-fixture rows with FPL's
own xG/xA/xGC, minutes, starts, points and xP), downloaded once and cached under .cache/vaastav.

Known differences from live running (read the results with these in mind):
  * No injury/suspension flags exist in the dataset, so every player is treated as available.
    FPL's xP does know about injuries — so the "played" subset (minutes > 0) is also reported,
    which compares the two on points given that the player appeared.
  * "Last season" comes from the same FPL dataset the live model now reads (fpl_history).
  * Odds are football-data.co.uk's market averages, collected shortly before each round — about the
    same time the live pipeline reads the upcoming round's odds.
  * No calibration multiplier and no World Cup form factor (identity).
  * DefCon points only exist from 2025/26, so earlier seasons project zero DefCon (their rules).
  * The dataset's xP column is broken for 2025/26 (mean 0.34 vs 1.17 actual points; earlier seasons
    track actual closely), so xP is checked per season and dropped where it doesn't line up. The
    head-to-head scope "vs_xP" only covers seasons where the benchmark is valid.

    python -m fpl_worker.backtest                          # 2023-24 .. 2026-27 (season in progress)
    python -m fpl_worker.backtest --refresh-current        # first rebuild 2026-27 from the FPL API
    python -m fpl_worker.backtest --seasons 2025-26 --from-gw 4
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import date
from pathlib import Path

import pandas as pd

from datetime import datetime

from . import bonus_sim, context_model, form_model, fpl_history, model, schedules, team_model

CACHE = fpl_history.CACHE
REPORTS = Path(__file__).resolve().parent.parent / "reports"
DEFAULT_SEASONS = ["2023-24", "2024-25", "2025-26", "2026-27"]  # the last is the season in progress
ELEMENT_TYPE = {"GK": 1, "DEF": 2, "MID": 3, "FWD": 4}
DEFCON_FROM_SEASON = "2025-26"
TOP_K = 20
XP_VALID_RATIO = 0.6  # a season's mean xP must be at least 60% of mean actual points to be a usable benchmark

# Data loading lives in fpl_history (shared with the live model); these aliases keep older callers working.
load_season = fpl_history.load_season
teams = fpl_history.teams
_prev = fpl_history.prev_season


def season_odds(season: str, names: list[str]) -> dict:
    """Market expected goals per (home, away) for a season, from football-data.co.uk (cached)."""
    local = CACHE / season / "football_data_E0.csv"
    if not local.exists():
        local.parent.mkdir(parents=True, exist_ok=True)
        a, b = season.split("-")
        team_model.season_odds(f"{a[2:]}{b}").to_csv(local, index=False)
    return team_model.odds_rows(pd.read_csv(local), names)


# --- one gameweek -------------------------------------------------------------

def predict_gw(df: pd.DataFrame, g: int, season: str, team_list: list[dict], profiles: dict,
               base: dict, tm: dict, asof: int | None = None) -> pd.DataFrame:
    """Model predictions for every player-row of GW g, using only rows from GWs before `asof` (default g).
    asof < g projects ahead, as the live optimizer does: odds are then left out (they only exist for the
    next round live)."""
    asof = g if asof is None else asof
    past = df[df["round"] < asof]
    now = df[df["round"] == g]
    id_to_name = {t["fpl_id"]: t["name"] for t in team_list}

    # Team goals model fitted on last season + this season's matches before `asof`, dated at its first kickoff.
    deadline_rows = df[df["round"] == asof] if (df["round"] == asof).any() else now
    ref = min(datetime.fromisoformat(str(k).replace("Z", "+00:00")) for k in deadline_rows["kickoff_time"])
    fitted = [m for m in tm["cur"] if m["round"] < asof]
    strengths = team_model.fit(tm["prev"] + fitted, ref, tm["teams"], tm["promoted"])

    # This season's per-GW history per player — the same shape the live model builds from event/{gw}/live.
    history = fpl_history.entries_before(past, asof - 1)
    opp_ratios = context_model.opp_position_ratios(tm["opp_prev"] + [r[:4] for r in tm["opp_cur"] if r[4] < asof])

    # DefCon per-90 (2025/26 rules onward), from this season's counts so far.
    dc90: dict[int, float] = {}
    if season >= DEFCON_FROM_SEASON:
        cur = past.groupby("element")[["minutes", "defensive_contribution"]].sum()
        code = now.groupby("element")["code"].first()
        els = [{"id": int(e), "element_type": ELEMENT_TYPE[p], "minutes": cur.loc[e, "minutes"] if e in cur.index else 0,
                "defensive_contribution": cur.loc[e, "defensive_contribution"] if e in cur.index else 0,
                "code": int(code[e]) if pd.notna(code[e]) else None}
               for e, p in now.groupby("element")["pos"].first().items()]
        dc90 = model.defcon_rates(els, profiles)

    out = []
    for r in now.itertuples(index=False):
        e = int(r.element)
        last = profiles.get(str(int(r.code))) if pd.notna(r.code) else None
        hist = history.get(e, [])
        prof = form_model.form_profile(hist, last, base[r.pos], pos=r.pos)
        prof["dc90"] = dc90.get(e, 0.0)
        player = {"position": r.pos, "status": "a", "chance_of_playing_next_round": None,
                  "mprof": model.minutes_profile([h for h in hist if h["age"] < model.MINUTES_WINDOW],
                                                 last["minutes"] if last else None)}
        opp = id_to_name[int(r.opponent_team)]
        h, a = (r.team, opp) if r.was_home else (opp, r.team)
        lam_h, lam_a = team_model.blend(team_model.model_goals(strengths, h, a),
                                        tm["odds"].get((h, a)) if g == asof else None)
        lam_for, lam_against = (lam_h, lam_a) if r.was_home else (lam_a, lam_h)
        rot, _ = context_model.rotation_factor(tm["dates"].get(r.team, []), date.fromisoformat(str(r.kickoff_time)[:10]))
        comp = model.project_fixture(player, prof, lam_for, lam_against,
                                     team_model.average_goals_for(strengths, r.team),
                                     team_model.average_goals_against(strengths, r.team), bool(r.was_home),
                                     opp_mult=context_model.opp_multiplier(opp_ratios, opp, r.pos), rotation=rot)
        f4 = model.form4(hist, last)
        if model.FORM_BLEND:
            a, b, c = model.FORM_BLEND[r.pos]
            comp["x_pts"] = max(0.0, a * comp["x_pts"] + b * f4 + c)
        out.append({"element": e, "round": g, "pos": r.pos, "pred": comp["x_pts"], "p_start": comp["p_start"], "form4": f4,
                    "actual": r.total_points, "minutes": r.minutes, "starts": r.starts, "xP": r.xP,
                    "bonus": r.bonus, "fixture": int(r.fixture), "side": 0 if r.was_home else 1, "lam_for": lam_for,
                    "x_bonus": comp["x_bonus_pts"], "p_play": comp["p_play"], "p_60": comp["p_60"],
                    "xg90": comp["xg90"], "xa90": comp["xa90"], "bbps90": prof["bbps90"]})
    rows = pd.DataFrame(out)
    if model.BONUS_SIM:
        rows["pred"] -= rows["x_bonus"]
        for _, m in rows.groupby("fixture"):
            lam = tuple(m.loc[m["side"] == s, "lam_for"].iloc[0] if (m["side"] == s).any() else 0.0 for s in (0, 1))
            rows.loc[m.index, "x_bonus"] = bonus_sim.simulate(m.to_dict("records"), lam)
        rows["pred"] += rows["x_bonus"]
    # A double gameweek has two rows: sum points and predictions; xP is already the GW total.
    return rows.groupby(["element", "round", "pos"], as_index=False).agg(
        pred=("pred", "sum"), p_start=("p_start", "first"), actual=("actual", "sum"),
        minutes=("minutes", "sum"), starts=("starts", "max"), xP=("xP", "first"),
        bonus=("bonus", "sum"), x_bonus=("x_bonus", "sum"), form4=("form4", "first"))


def season_setup(season: str) -> tuple:
    """Everything predict_gw needs for a season: (df, team_list, profiles, base, tm)."""
    df = load_season(season)
    prev = load_season(_prev(season))
    profiles = fpl_history.last_season_profiles(prev)
    base = form_model.base_rates(profiles)
    team_list = [{"fpl_id": int(r.id), "name": r.name} for r in teams(season).itertuples(index=False)]
    names = [t["name"] for t in team_list]
    prev_names = list(teams(_prev(season))["name"])
    tm = {
        "prev": fpl_history.season_matches(prev),
        "cur": fpl_history.season_matches(df),
        "teams": sorted(set(names) | set(prev_names)),
        "promoted": set(names) - set(prev_names),
        "odds": season_odds(season, names),
    }
    # Opponent-vs-position records (opponent, position, xG+xA, match key[, round]) and all-competition dates.
    prev_ids = {int(t.id): t.name for t in teams(_prev(season)).itertuples(index=False)}
    cur_ids = {t["fpl_id"]: t["name"] for t in team_list}
    tm["opp_prev"] = [(prev_ids[int(o)], p, x + a, f"p{f}") for o, p, x, a, f in
                      prev[["opponent_team", "pos", "expected_goals", "expected_assists", "fixture"]].itertuples(index=False)]
    tm["opp_cur"] = [(cur_ids[int(o)], p, x + a, f"c{f}", int(rd)) for o, p, x, a, f, rd in
                     df[["opponent_team", "pos", "expected_goals", "expected_assists", "fixture", "round"]].itertuples(index=False)]
    start, end = context_model.season_window(str(df["kickoff_time"].min()), str(df["kickoff_time"].max()))
    league = list(df[["team", "kickoff_time"]].drop_duplicates().itertuples(index=False, name=None))
    tm["dates"] = schedules.team_dates(schedules.season_matches(season, start, end),
                                       [(t, str(k)) for t, k in league], names)
    return df, team_list, profiles, base, tm


def run_season(season: str, from_gw: int = 1) -> pd.DataFrame:
    df, team_list, profiles, base, tm = season_setup(season)
    frames = []
    for g in sorted(df["round"].unique()):
        if g < from_gw:
            continue
        frames.append(predict_gw(df, int(g), season, team_list, profiles, base, tm))
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
    # RMSE is the headline: for expected points (skewed, many zeros) MAE rewards simply predicting lower.
    lines.append("| Scope | n | Model RMSE | xP RMSE | Model MAE | xP MAE | Model MAE (played) | xP MAE (played) | Model ρ | xP ρ "
                 "| Model top-20 | xP top-20 | Oracle top-20 | Model capt | xP capt | P(start) Brier |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    def xv(x, *keys):
        if x is None:
            return "—"
        for k in keys:
            x = x[k]
        return x

    for scope, s in results.items():
        m, x, o = s["model"], s["fpl_xP"], s["oracle"]
        lines.append(f"| {scope} | {s['n']} | {m['all']['rmse']} | {xv(x, 'all', 'rmse')} | {m['all']['mae']} | {xv(x, 'all', 'mae')} | {m['played']['mae']} | "
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
    parser.add_argument("--refresh-current", action="store_true",
                        help="rebuild the last season's files from the FPL API first (the vaastav repo lags)")
    args = parser.parse_args()
    if args.refresh_current:
        fpl_history.build_current_season(args.seasons[-1])

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
