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
