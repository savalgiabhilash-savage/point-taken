"""Match-context factors (accuracy plan factors 6, 7), with a strength the backtest tunes.

Fixture congestion and rest (6, 7)
    If his club has another match (any competition) within SHORT_GAP_DAYS before or after a league game,
    managers rotate: his start chance is multiplied by (1 - CONGESTION). CONGESTION = 0 switches it off.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import date, timedelta

CONGESTION = 0.08  # tuned 2023-24 on RMSE + P(start) Brier; stronger values only lowered the overall level
SHORT_GAP_DAYS = 3


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


def season_window(first: str, last: str) -> tuple[date, date]:
    """Date span to fetch other-competition fixtures for, with a week's margin either side."""
    return date.fromisoformat(first[:10]) - timedelta(days=7), date.fromisoformat(last[:10]) + timedelta(days=7)
