"""Bonus simulation (accuracy plan step 4): expected bonus from simulating the Bonus Points System.

FPL gives 3/2/1 bonus to the three highest BPS scores in each match, so a player's bonus depends on
everyone else on the pitch: a defender's clean sheet competes with a striker's goal. The rate model
(model.BONUS_MODEL) ignores that; this simulates each match many times instead:

  1. Each team's goals ~ Poisson(its expected goals for this fixture).
  2. Each player appears with P(play); starters reach 60' with P(60 | start); otherwise a short spell.
  3. Each goal goes to a player on the pitch in proportion to his expected goals per 90 x minutes
     (the rest of the team's expected goals = "someone else"); its assist likewise by expected assists.
  4. BPS = his background BPS per 90 x minutes (passes, tackles, saves... from his history) + noise
     + minutes BPS (3 / 6) + goals (12 GK/DEF, 18 MID, 24 FWD) + assists (9)
     + clean sheet 12 and -4 per 2 goals conceded for GK/DEF who played 60'.
  5. Rank the match's BPS: 3/2/1 to the top three. Expected bonus = the average over simulations.
"""

from __future__ import annotations

import numpy as np

from .form_model import GOAL_BPS

N_SIMS = 2000
NOISE_SD = 3.0        # match-to-match spread of background BPS (3-10 tested; little difference)
MAX_GOALS = 8
START_60_MIN, START_SUB_MIN, CAMEO_MIN = 85.0, 50.0, 20.0
_RNG = np.random.default_rng(7)


def simulate(players: list[dict], lam: tuple[float, float], n: int = N_SIMS) -> np.ndarray:
    """Expected bonus per player for one match.

    players: dicts with side (0 home / 1 away), pos, p_play, p_start, p_60, xg90, xa90 (this fixture),
    bbps90 (background BPS per 90). lam: expected goals (home, away)."""
    P = len(players)
    if P == 0:
        return np.zeros(0)
    side = np.array([p["side"] for p in players])
    pos = [p["pos"] for p in players]
    p_play = np.array([p["p_play"] for p in players])
    p_start = np.minimum(np.array([p["p_start"] for p in players]), p_play)
    p_60 = np.minimum(np.array([p["p_60"] for p in players]), p_start)
    xg90 = np.array([p["xg90"] for p in players])
    xa90 = np.array([p["xa90"] for p in players])
    bbps90 = np.array([p["bbps90"] for p in players])
    goal_bps = np.array([GOAL_BPS.get(x, 18) for x in pos])
    defender = np.array([x in ("GK", "DEF") for x in pos])

    # Minutes: one uniform per player per sim decides 60'+ start / shorter start / cameo / no show.
    u = _RNG.random((n, P))
    mins = np.where(u < p_60, START_60_MIN,
                    np.where(u < p_start, START_SUB_MIN, np.where(u < p_play, CAMEO_MIN, 0.0)))
    on = mins > 0
    full = mins >= 60

    bps = (bbps90 * mins / 90.0 + NOISE_SD * np.sqrt(mins / 90.0) * _RNG.standard_normal((n, P))
           + np.where(full, 6.0, np.where(on, 3.0, 0.0)))

    goals_by_side = []
    for s in (0, 1):
        idx = np.where(side == s)[0]
        k = np.minimum(_RNG.poisson(lam[s], n), MAX_GOALS)
        goals_by_side.append(k)
        if len(idx) == 0:
            continue
        frac = mins[:, idx] / 90.0
        for rate, pts in ((xg90[idx], goal_bps[idx]), (xa90[idx], 9.0)):
            w = rate * frac                                            # n x p: his share of this sim's chances
            total = np.maximum(w.sum(1), lam[s])                       # remainder = someone not modelled
            cum = np.cumsum(w, 1) / total[:, None]
            r = _RNG.random((n, MAX_GOALS))
            who = (cum[:, None, :] < r[:, :, None]).sum(-1)            # n x MAX_GOALS, p = nobody here
            who = np.where(np.arange(MAX_GOALS)[None, :] < k[:, None], who, len(idx))
            counts = np.zeros((n, len(idx) + 1))
            np.add.at(counts, (np.repeat(np.arange(n), MAX_GOALS), who.ravel()), 1)
            bps[:, idx] += counts[:, :-1] * pts

    conceded = np.stack([goals_by_side[1], goals_by_side[0]], 1)[:, side]   # n x P: goals against his team
    bps += np.where(defender & full, np.where(conceded == 0, 12.0, -4.0 * (conceded // 2)), 0.0)

    # 3/2/1 to the top three BPS among players who appeared.
    bps = np.where(on, bps, -np.inf)
    top = np.argsort(-bps, 1)[:, :3]
    bonus = np.zeros((n, P))
    rows = np.arange(n)
    for place, pts in enumerate((3.0, 2.0, 1.0)):
        j = top[:, place]
        bonus[rows, j] += np.where(np.isfinite(bps[rows, j]), pts, 0.0)
    return bonus.mean(0)
