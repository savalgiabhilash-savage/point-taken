"""Risk profiles: Safe / Balanced / Bold. The optimizer maximises a profile-adjusted value instead of plain
expected points; Balanced is plain expected points (unchanged).

For each player and gameweek, from his projection (x_pts), his simulated range (p10 floor, p90 ceiling,
outcomes.py), his ownership (share of managers, 0-1) and his chance of starting:

  Bold      v = xp + UPSIDE x (p90 - xp)  -  OWN_W x xp x ownership
              -> rewards a high ceiling and lightly owned players (a haul then gains rank on most rivals)
  Safe      v = xp - DOWNSIDE x (xp - p10)  +  OWN_W x xp x ownership,  x ROTATION if P(start) < 0.7
              -> rewards a high floor and template players (their points don't cost rank) and avoids
                 rotation risks
  Balanced  v = xp

Hits are charged at HIT_COST[profile] in the plan (Bold takes them more readily, Safe less). Captain and
chips follow the same values, so a Bold Triple Captain goes on the highest ceiling.
Each profile's cost in expected points is measured on every run (the Balanced plan valued the same way)
and over three past seasons in optimizer_backtest --risk.
"""

from __future__ import annotations

PROFILES = ("safe", "balanced", "bold")
UPSIDE = 0.25
DOWNSIDE = 0.25
OWN_W = 0.15
ROTATION = 0.9
HIT_COST = {"safe": 5.0, "balanced": 4.0, "bold": 3.0}

# Replay only (past seasons have no simulated ranges): floor and ceiling from expected points, fitted per
# position on the live model's ranges (GW12-14 2026, single-fixture weeks).
RANGE_FIT = {"GK": ((1.68, 2.19), (0.35, -0.68)), "DEF": ((1.96, 1.63), (0.07, -0.12)),
             "MID": ((2.18, 0.25), (0.25, -0.34)), "FWD": ((2.34, 0.06), (0.26, -0.37))}


def fitted_range(xp: float, pos: str) -> tuple[float, float]:
    (a, b), (c, d) = RANGE_FIT[pos]
    return max(0.0, c * xp + d), max(xp, a * xp + b)


def value(xp: float, p10: float | None, p90: float | None, own: float, p_start: float | None, profile: str) -> float:
    """Profile-adjusted value of one player-gameweek (equals xp for Balanced or missing inputs)."""
    if profile == "bold":
        up = UPSIDE * (p90 - xp) if p90 is not None else 0.0
        return max(0.0, xp + up - OWN_W * xp * own)
    if profile == "safe":
        down = DOWNSIDE * (xp - p10) if p10 is not None else 0.0
        v = xp - down + OWN_W * xp * own
        if p_start is not None and p_start < 0.7:
            v *= ROTATION
        return max(0.0, v)
    return xp
