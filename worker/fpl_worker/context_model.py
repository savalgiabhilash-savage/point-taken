"""Match-context factors (accuracy plan factors 6, 7, 9), each with a strength the backtest tunes.

Fixture congestion and rest (6, 7)
    If his club has another match (any competition) within SHORT_GAP_DAYS before or after a league game,
    managers rotate: his start chance is multiplied by (1 - CONGESTION). CONGESTION = 0 switches it off.

Opponent vs position (9)
    Some sides leak chances to full-backs, others to strikers. For each opponent: the share of the xG+xA
    it concedes that goes to each position, versus the league-wide share, shrunk toward 1 by OPP_POS_K
    matches. His goals and assists against that opponent are multiplied by ratio ** OPP_POS_STRENGTH.
    The opponent's overall leakiness is already in the team goals model; this only redistributes it.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import date, timedelta

CONGESTION = 0.08  # tuned 2023-24 on RMSE + P(start) Brier; stronger values only lowered the overall level
SHORT_GAP_DAYS = 3
OPP_POS_STRENGTH = 0.0  # off: no RMSE or ranking gain in the 2023-24 backtest
OPP_POS_K = 10.0


def rotation_factor(dates: list[date], match_day: date) -> tuple[float, int | None]:
    """(start-chance multiplier, days to the nearest other match) for a league game on match_day."""
    if not dates:
        return 1.0, None
    i, j = bisect_left(dates, match_day), bisect_right(dates, match_day)
    gaps = []
    if i > 0:
        gaps.append((match_day - dates[i - 1]).days)
    if j < len(dates):
        gaps.append((dates[j] - match_day).days)
    nearest = min(gaps) if gaps else None
    congested = nearest is not None and nearest <= SHORT_GAP_DAYS
    return (1.0 - CONGESTION if congested else 1.0), nearest


def opp_position_ratios(records: list[tuple[str, str, float, str]]) -> dict[tuple[str, str], float]:
    """records: (opponent, position, xG+xA of that player, match key). Returns {(opponent, position): ratio}."""
    conc: dict[tuple[str, str], float] = {}
    total: dict[str, float] = {}
    matches: dict[str, set] = {}
    league: dict[str, float] = {}
    for opp, pos, xgi, key in records:
        conc[(opp, pos)] = conc.get((opp, pos), 0.0) + xgi
        total[opp] = total.get(opp, 0.0) + xgi
        matches.setdefault(opp, set()).add(key)
        league[pos] = league.get(pos, 0.0) + xgi
    all_xgi = sum(league.values()) or 1.0
    n_matches = sum(len(m) for m in matches.values()) or 1
    per_match = all_xgi / n_matches  # league-average xG+xA conceded per match
    out = {}
    for (opp, pos), c in conc.items():
        share = league[pos] / all_xgi
        k = OPP_POS_K * per_match
        out[(opp, pos)] = (c + k * share) / (share * (total[opp] + k)) if share else 1.0
    return out


def opp_multiplier(ratios: dict[tuple[str, str], float], opp: str, pos: str) -> float:
    if not OPP_POS_STRENGTH:
        return 1.0
    return ratios.get((opp, pos), 1.0) ** OPP_POS_STRENGTH


def season_window(first: str, last: str) -> tuple[date, date]:
    """Date span to fetch other-competition fixtures for, with a week's margin either side."""
    return date.fromisoformat(first[:10]) - timedelta(days=7), date.fromisoformat(last[:10]) + timedelta(days=7)
