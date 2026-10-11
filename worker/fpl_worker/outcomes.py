"""Range of outcomes (accuracy plan step 5): each player's full points distribution for a gameweek, not
just the average, so captain and Triple Captain calls can see the floor, the ceiling and the haul chance.

Each fixture is simulated N times from the same components project_fixture() computes, so the simulated
average matches x_pts:
  1. Minutes: one draw decides 60'+ start / shorter start / cameo / no appearance (P(60), P(start), P(play)).
  2. His goals and assists ~ Poisson(expected goals / assists), scaled by the minutes drawn.
  3. His team concedes ~ Poisson(xG against): clean sheet (60'+ only), -1 per 2 conceded (GK/DEF who
     started), saves ~ Poisson(SAVES_PER_XGA x xG against) for a starting GK, 1 pt per 3.
  4. DefCon: 2 pts with P(reaching the threshold) when he starts. Yellow card: -1 with his card rate.
  5. Bonus goes mostly to players who score, assist or keep a clean sheet: each draw's bonus is
     proportional to (0.3 + 1.5 x goals + 1.0 x assists + 1.0 x clean sheet), scaled so its average equals
     his projected bonus, rounded at random to whole points and capped at 3.
A double gameweek adds its fixtures' draws. Team-mates aren't correlated (each player is drawn alone),
which is fine for his own range.
"""

from __future__ import annotations

import numpy as np

N = 2000
HAUL = 10            # "haul" = 10+ points (a captain then scores 20+)
BLANK = 2            # "blank" = 2 points or fewer
FULL_M, SHORT_M, CAMEO_M = 1.0, 0.6, 0.22   # share of 90' in each minutes state (relative weights only)
# Good and bad days: one shared gamma multiplier (mean 1, variance DAY_VAR) on his goal and assist rates per
# draw. Plain Poisson made 10+ hauls ~30% rarer than they really are in 2023-27; 0 = off.
DAY_VAR = 1.0      # tuned on 2023-25 (0.5-2.0 tested), confirmed on 2025-26 + 2026-27


def sample_fixture(comp: dict, pos: str, lam_against: float, yellow90: float, rng: np.random.Generator,
                   goal_pts: int, cs_pts: int, saves_per_xga: float | None, n: int = N) -> np.ndarray:
    """N simulated FPL point totals for one player in one fixture (comp = project_fixture's output)."""
    p_play, p_start, p_60 = comp["p_play"], min(comp["p_start"], comp["p_play"]), min(comp["p_60"], comp["p_start"])
    u = rng.random(n)
    full = u < p_60
    started = u < p_start
    played = u < p_play
    m = np.where(full, FULL_M, np.where(started, SHORT_M, np.where(played, CAMEO_M, 0.0)))
    e_m = p_60 * FULL_M + (p_start - p_60) * SHORT_M + (p_play - p_start) * CAMEO_M
    scale = m / e_m if e_m > 0 else m * 0.0       # so the average goal/assist rate matches the projection
    if DAY_VAR > 0:
        scale = scale * rng.gamma(1.0 / DAY_VAR, DAY_VAR, n)

    goals = rng.poisson(comp["x_goals_pts"] / goal_pts * scale) if goal_pts else np.zeros(n)
    assists = rng.poisson(comp["x_assist_pts"] / 3.0 * scale)
    conceded = rng.poisson(lam_against, n)
    cs = full & (conceded == 0)

    pts = played * 1.0 + full * 1.0 + goals * goal_pts + assists * 3.0 + cs * cs_pts
    if pos in ("GK", "DEF"):
        pts -= started * (conceded // 2)
    if pos == "GK":
        if saves_per_xga:
            pts += started * (rng.poisson(saves_per_xga * lam_against, n) // 3)
        else:
            pts += comp["x_saves_pts"] / max(p_start, 1e-9) * started
    if comp.get("p_dc"):
        pts += 2.0 * (started & (rng.random(n) < comp["p_dc"]))
    pts -= rng.random(n) < np.minimum(1.0, yellow90 * comp["exp_minutes"] / 90.0 * scale)

    # bonus: concentrated on draws where he returned, average = his projected bonus
    w = played * (0.3 + 1.5 * goals + 1.0 * assists + 1.0 * cs * (pos in ("GK", "DEF")))
    mw = w.mean()
    if mw > 0 and comp["x_bonus_pts"] > 0:
        b = comp["x_bonus_pts"] / mw * w
        b = np.floor(b) + (rng.random(n) < (b - np.floor(b)))
        pts += np.minimum(b, 3.0)
    return pts


def summarise(samples: np.ndarray) -> dict:
    """Floor / median / ceiling and the haul and blank chances, for storing on a projection."""
    p10, p50, p90 = np.percentile(samples, [10, 50, 90])
    return {"p10": round(float(p10), 1), "p50": round(float(p50), 1), "p90": round(float(p90), 1),
            "p_haul": round(float((samples >= HAUL).mean()), 3), "p_blank": round(float((samples <= BLANK).mean()), 3)}
