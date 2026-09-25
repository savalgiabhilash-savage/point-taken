"""Data-driven custom Fixture Difficulty Rating (1-5) from last season's team xG.

Preseason, FPL's own granular team strengths are all 0, so we derive team quality from
2025/26 Understat xG instead: each team's xG-for per game (attack) minus xG-against per game
(defence) = an xG-difference rating. A fixture's difficulty for a team scales with the
OPPONENT's rating, normalised across the league to 1-5, with a small home-advantage nudge.

Season-transition: promoted clubs (Coventry/Hull/Ipswich) have no 2025/26 PL data, so they
take a fallback rating equal to the weakest returning team.
"""

from __future__ import annotations

import soccerdata as sd

from .crosswalk import UNDERSTAT_TO_FPL_TEAM
from .soccer_stats import BASELINE_SEASON, LEAGUE

HOME_ADVANTAGE = 0.25  # on the 1-5 scale: home fixtures a touch easier, away a touch harder


def team_ratings(season: str = BASELINE_SEASON) -> dict[str, dict]:
    """Understat team match stats -> {fpl_team_name: {xgf_pg, xga_pg, rating}}."""
    us = sd.Understat(leagues=LEAGUE, seasons=season)
    df = us.read_team_match_stats().reset_index()

    acc: dict[str, list[float]] = {}  # team -> [xg_for, xg_against, games]
    for _, r in df.iterrows():
        home = UNDERSTAT_TO_FPL_TEAM.get(r["home_team"], r["home_team"])
        away = UNDERSTAT_TO_FPL_TEAM.get(r["away_team"], r["away_team"])
        hx, ax = float(r["home_xg"]), float(r["away_xg"])
        acc.setdefault(home, [0.0, 0.0, 0])
        acc.setdefault(away, [0.0, 0.0, 0])
        acc[home][0] += hx
        acc[home][1] += ax
        acc[home][2] += 1
        acc[away][0] += ax
        acc[away][1] += hx
        acc[away][2] += 1

    out: dict[str, dict] = {}
    for team, (xgf, xga, games) in acc.items():
        if games:
            out[team] = {
                "xgf_pg": xgf / games,
                "xga_pg": xga / games,
                "rating": (xgf - xga) / games,
            }
    return out


LAST_SEASON_WEIGHT = 0.5  # a last-season game counts half as much as a game this season
LAST_SEASON_GAMES = 38


def blend_with_current(last_by_name: dict[str, dict], teams: list[dict], players: list[dict],
                       fixtures: list[dict]) -> dict[str, dict]:
    """Update last season's team xG with this season's, so team strength moves in-season.

    This season's numbers come from FPL itself (Understat's current season isn't available through
    soccerdata): xG for = sum of the club's players' expected_goals; xG against = sum of their
    expected_goals_conceded / 11, because all 11 players on the pitch accrue every chance conceded.
    Per game, pooled with last season at LAST_SEASON_WEIGHT. Promoted clubs use this season alone.
    teams: {fpl_id, name}; players: {team_id, expected_goals, expected_goals_conceded};
    fixtures: {team_h, team_a, finished}. Returns {fpl_team_name: {xgf_pg, xga_pg, rating}}."""
    games: dict[int, int] = {}
    for f in fixtures:
        if f.get("finished"):
            for t in (f["team_h"], f["team_a"]):
                games[t] = games.get(t, 0) + 1
    xgf: dict[int, float] = {}
    xgc: dict[int, float] = {}
    for p in players:
        t = p["team_id"]
        xgf[t] = xgf.get(t, 0.0) + float(p.get("expected_goals") or 0)
        xgc[t] = xgc.get(t, 0.0) + float(p.get("expected_goals_conceded") or 0)

    out: dict[str, dict] = {}
    for t in teams:
        last = last_by_name.get(t["name"])
        g = games.get(t["fpl_id"], 0)
        w_games = (LAST_SEASON_WEIGHT * LAST_SEASON_GAMES if last else 0.0) + g
        if w_games == 0:
            continue  # promoted club preseason: callers apply the weakest-team fallback
        f_tot = (LAST_SEASON_WEIGHT * LAST_SEASON_GAMES * last["xgf_pg"] if last else 0.0) + xgf.get(t["fpl_id"], 0.0)
        a_tot = (LAST_SEASON_WEIGHT * LAST_SEASON_GAMES * last["xga_pg"] if last else 0.0) + xgc.get(t["fpl_id"], 0.0) / 11.0
        out[t["name"]] = {"xgf_pg": f_tot / w_games, "xga_pg": a_tot / w_games,
                          "rating": (f_tot - a_tot) / w_games}
    return out


def compute_fdr(fpl_teams: list[dict], fixtures: list[dict], ratings: dict[str, dict]) -> list[dict]:
    """fpl_teams: {fpl_id, name}. fixtures: {fpl_id, team_h, team_a}. Returns fixture rows
    with custom_fdr_h / custom_fdr_a."""
    rating_by_id: dict[int, float | None] = {
        t["fpl_id"]: (ratings.get(t["name"]) or {}).get("rating") for t in fpl_teams
    }
    known = [v for v in rating_by_id.values() if v is not None]
    fallback = min(known)  # promoted clubs ~ weakest returning team
    rating_by_id = {k: (v if v is not None else fallback) for k, v in rating_by_id.items()}

    lo, hi = min(rating_by_id.values()), max(rating_by_id.values())

    def difficulty(opp_id: int) -> float:
        if hi == lo:
            return 3.0
        return 1.0 + 4.0 * (rating_by_id[opp_id] - lo) / (hi - lo)

    def clamp(x: float) -> float:
        return round(min(5.0, max(1.0, x)), 2)

    rows = []
    for fx in fixtures:
        if fx["team_h"] is None or fx["team_a"] is None:
            continue
        rows.append(
            {
                "fpl_id": fx["fpl_id"],
                "custom_fdr_h": clamp(difficulty(fx["team_a"]) - HOME_ADVANTAGE),
                "custom_fdr_a": clamp(difficulty(fx["team_h"]) + HOME_ADVANTAGE),
            }
        )
    return rows
