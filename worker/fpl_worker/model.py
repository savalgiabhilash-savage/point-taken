"""Rules-based expected-points (xPts) model — Phase 3, spec §3.1.

Transparent by design: every projection is the sum of named components, each stored so the UI
can explain the headline number. Attacking output pools last-season Understat xG (via the crosswalk,
half weight) with this season's FPL xG; minutes come from each player's recent GWs; defensive
contributions use each player's FPL per-90 rate; each fixture's expected goals for and against come
from the team goals model (team_model.py: fitted team strengths blended with bookmaker odds).

    python -m fpl_worker.model --dry-run            # compute + print top projections, no DB write
    python -m fpl_worker.model --run --horizon 5    # write projections for the next 5 GWs
"""

from __future__ import annotations

import argparse
import math

from dotenv import load_dotenv

from datetime import datetime, timezone

import numpy as np

from . import context_model, db, form_model, fpl_history, outcomes, price_model, schedules, team_model
from .fpl_client import FplClient

# rules-v6: congestion, live-learned set pieces/return/line-ups/manager change, price signal. rules-v5: role share, bonus rate, game state, FPL-dataset priors (form_model.py). rules-v4: news lowers availability (news_adjustment). rules-v3: team goals model + odds (team_model.py). rules-v2: recency-weighted minutes (minutes_profile). Bump on any change to how xPts is computed,
# together with MODEL_VERSION in web/lib/supabase.ts and mobile/src/lib/supabase.ts.
MODEL_VERSION = "rules-v6"

GOAL_PTS = {"GK": 10, "DEF": 6, "MID": 5, "FWD": 4}  # FPL game_config scoring (GK goal = 10 since 2025/26)
CS_PTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
ASSIST_PTS = 3
DEFCON_PTS = 2
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}  # actions per match for the 2 pts; GKs can't earn it
DEFCON_VMR = 1.0     # DefCon variance / mean (1 = Poisson). 1.5-2.5 tested on 2025-26: RMSE gain 0.0006, captain worse; off
SAVES_PER_XGA = 2.1   # saves ~ Poisson(2.1 x xGA), 1 pt per 3 (2.0-2.1 in 2023-26 data); None = old xGA x 2/3 rule
DEFCON_K = 3.0
DEFCON_LAST_W = 0.0  # last season's DefCon in a player's rate; 1-2 tested on 2026-27 (worse RMSE, top-20), off
CS_DISP = 0.0        # gamma-mixed clean sheets; 0.1-0.35 tested on 2023-24 (worse RMSE), off = plain Poisson
# Recent-points blend (accuracy plan step 6, first piece): per position, x_pts' = a·x_pts + b·form4 + c, where
# form4 = his average FPL points over his club's last 4 GWs (last season's points per game before that).
# Fitted by least squares on past seasons (see backtest); None = off.
# Tested 2026-10-11 on 2023-24 .. 2026-27 GW1-5, off: least-squares fits (a 0.82-0.95, b 0.06-0.15) lowered
# RMSE slightly but cost top-20 points in 3 of 4 seasons; a light b = 0.05 was a wash (RMSE -0.002 at best,
# one season's captain points -0.8); b >= 0.2 clearly hurts the picks. Chasing recent points loses to the
# underlying-numbers model. e.g. {"MID": (1.0, 0.05, -0.061), ...}
FORM_BLEND: dict[str, tuple[float, float, float]] | None = None  # shrink a player's DefCon per-90 toward the position average by 3 virtual 90s
LAST_GW = 38
# Minutes model (see minutes_profile): recent gameweeks count most.
MINUTES_WINDOW = 8          # most recent finished gameweeks used
MINUTES_HALF_LIFE = 3.0     # a gameweek's weight halves every 3 GWs back
PRIOR_GAMES = 0.5           # last season's start rate counts as half a game of evidence (tuned on 2023-24)
SHAPE_K = 3.0               # shrink minutes-shape rates toward the defaults by 3 virtual games
START_MINS_DEFAULT = 85.0   # minutes when starting
P60_DEFAULT = 0.88          # P(60+ minutes | start)
CAMEO_RATE_DEFAULT = 0.15   # P(comes off the bench | doesn't start)
CAMEO_MINS_DEFAULT = 20.0   # minutes of a sub appearance

# News (news_job.py: Google News + Claude) lowers availability. Claude's minutes_risk_adj (0 .. -1) is scaled
# by how directly the topic affects playing time, and fades with age (FPL's own flag catches up within days).
NEWS_TOPIC_WEIGHT = {"injury-risk": 1.0, "suspension": 1.0, "rotation": 0.75, "transfer": 0.5, "off-pitch": 0.5}
NEWS_FRESH_DAYS = 3.0       # full strength while this recent
NEWS_STALE_DAYS = 14.0      # no effect once this old
NEWS_WEIGHT = 1.0           # overall strength; learned weekly from outcomes (predict.py -> model_params)
CONGESTION_GWS = 6   # fetch other-competition fixtures this many GWs ahead

# Live-only factors (no gameweek-by-gameweek history exists to backtest them). Each has a strength learned
# weekly from outcomes (predict.py -> model_params "<factor>_weight"); these are the starting values.
PEN_RATE = 0.14          # penalties won per team per match (Premier League average)
PEN_CONVERSION = 0.78
CORNER_XA90 = 0.06       # extra xA per 90 for the main corner / indirect free-kick taker
FK_XG90 = 0.02           # extra xG per 90 for the main direct free-kick taker
RETURN_RAMP = 0.7        # first games back: this share of his pre-absence start rate
RETURN_MIN_ABSENT = 2    # consecutive club games missed to count as an absence
RETURN_PRE_RATE = 0.6    # ...by a player who was starting at least this often before it
LINEUP_TARGET = {True: 0.92, False: 0.10}  # start chance when named / left out of a predicted XI
FACTOR_WEIGHTS = {"penalty": 0.5, "setpiece": 0.5, "return": 1.0, "lineup": 0.7}
# model_params keys the weekly re-tune (tune.py) may override.
TUNED_PARAMS = {"congestion": (context_model, "CONGESTION"), "last_season_weight": (form_model, "LAST_SEASON_WEIGHT"),
                "share_k": (form_model, "SHARE_K")}
BONUS_MODEL = True   # factor 17: bonus from his own bonus rate (False = the old involvement proxy)
BONUS_SIM = False    # bonus from simulating each match's BPS ranking (bonus_sim.py); backtest-only, lost on RMSE (rev 16)
GAME_STATE = 0.0     # factor 16: start minutes x (1 - GAME_STATE x max(0, xG_for - xG_against)). Off: its MAE gain
                     # was only a lower overall level; RMSE (the right score for expected points) didn't improve

# --- minutes -----------------------------------------------------------------

def _availability(status: str | None, chance: int | None) -> float:
    if status in ("i", "s", "u", "n"):
        return 0.0
    if chance is not None:
        return chance / 100.0
    return 0.5 if status == "d" else 1.0  # 'd' doubtful, else available


def minutes_profile(history: list[dict], last_minutes: float | None) -> dict:
    """A player's minutes profile from their recent gameweeks.

    `history` has one entry per recent finished GW in which the player's club played:
    {age: GWs ago (0 = latest), games: club fixtures that GW, starts, minutes}. Each GW is weighted
    0.5 ** (age / MINUTES_HALF_LIFE), so the last few games dominate: a player dropped two weeks ago
    is priced as a rotation risk now, not at his season average.

      start_rate  = weighted starts / weighted games, blended with last season's rate
                    (last-season minutes / 2600) worth PRIOR_GAMES games. No history -> the prior;
                    no prior either (promoted club / new arrival) -> this season alone.
      p60_start   = share of full-start GWs with 60+ minutes      } each shrunk toward its default by
      start_mins  = average minutes in those starts                } SHAPE_K virtual games, so one
      cameo_rate  = share of non-start GWs with a sub appearance   } early sub-off or cameo doesn't
      cameo_mins  = average minutes of those appearances           } swing the profile
    GWs with a mix of starts and non-starts (a double) count toward the start rate only."""
    prior = min(1.0, last_minutes / 2600) if last_minutes else None  # ~29 full games = nailed
    wg = ws = 0.0
    w_start = start_min = start_60 = 0.0
    w_bench = w_cameo = cameo_min = 0.0
    for h in history:
        w = 0.5 ** (h["age"] / MINUTES_HALF_LIFE)
        games, starts, mins = h["games"], h["starts"], h["minutes"]
        wg += w * games
        ws += w * starts
        if games and starts == games:
            per = mins / games
            w_start += w
            start_min += w * per
            start_60 += w * (1.0 if per >= 60 else 0.0)
        elif starts == 0 and games:
            w_bench += w
            if mins > 0:
                w_cameo += w
                cameo_min += w * mins / games

    if wg == 0:
        start_rate = prior or 0.0
    elif prior is None:
        start_rate = ws / wg
    else:
        start_rate = (ws + PRIOR_GAMES * prior) / (wg + PRIOR_GAMES)

    def shrink(total: float, weight: float, default: float) -> float:
        return (total + SHAPE_K * default) / (weight + SHAPE_K)

    return {
        "start_rate": min(1.0, start_rate),
        "p60_start": shrink(start_60, w_start, P60_DEFAULT),
        "start_mins": shrink(start_min, w_start, START_MINS_DEFAULT),
        "cameo_rate": shrink(w_cameo, w_bench, CAMEO_RATE_DEFAULT),
        "cameo_mins": shrink(cameo_min, w_cameo, CAMEO_MINS_DEFAULT),
    }


def news_adjustment(news: dict | None, now: datetime) -> float:
    """Effective news effect on availability (0 = none, -1 = won't play): Claude's minutes_risk_adj x the
    strongest playing-time topic weight x a freshness factor. Positive news never raises availability."""
    if not news or not news.get("minutes_risk_adj"):
        return 0.0
    topic_w = max((NEWS_TOPIC_WEIGHT.get(t, 0.0) for t in (news.get("topics") or [])), default=0.0)
    age_days = 0.0
    if news.get("published_at"):
        age_days = (now - datetime.fromisoformat(news["published_at"].replace("Z", "+00:00"))).total_seconds() / 86400
    fresh = 1.0 if age_days <= NEWS_FRESH_DAYS else max(0.0, 1 - (age_days - NEWS_FRESH_DAYS) / (NEWS_STALE_DAYS - NEWS_FRESH_DAYS))
    return float(news["minutes_risk_adj"]) * topic_w * fresh


def availability(player: dict) -> tuple[float, float]:
    """(availability used, FPL-only availability). News can only lower it, and FPL's flag and the news are
    not stacked: the lower of the two wins, so one injury isn't counted twice."""
    fpl = _availability(player["status"], player["chance_of_playing_next_round"])
    news = max(0.0, 1.0 + NEWS_WEIGHT * player.get("news_adj", 0.0))
    return min(fpl, news), fpl


def _minutes(player: dict, game_state: float = 1.0, rotation: float = 1.0,
             lineup: tuple[bool, float] | None = None) -> tuple[float, float, float, float, float]:
    """Return (p_start, p_play, exp_minutes, p_60). `player["mprof"]` comes from minutes_profile().
    `game_state` (<= 1) shortens start minutes when his team is a heavy favourite (early subs);
    `rotation` (<= 1) lowers his start chance when his club has another match within a few days;
    `lineup` = (named in a predicted XI?, source confidence) moves it toward LINEUP_TARGET.
    Returns (p_start, p_play, exp_minutes, p_60, p_start before the line-up adjustment)."""
    m = player["mprof"]
    avail, _ = availability(player)
    p_start0 = avail * m["start_rate"] * rotation
    p_start = p_start0
    if lineup is not None and avail > 0:
        p_start += FACTOR_WEIGHTS["lineup"] * lineup[1] * (LINEUP_TARGET[lineup[0]] - p_start0)
        p_start = min(1.0, max(0.0, p_start))
    p_cameo = (1.0 - p_start) * (m["cameo_rate"] if avail > 0 else 0.0)
    p_play = min(1.0, p_start + p_cameo)
    exp_minutes = p_start * m["start_mins"] * game_state + p_cameo * m["cameo_mins"]
    p_60 = p_start * m["p60_start"]
    return p_start, p_play, exp_minutes, p_60, p_start0


# --- fixture / team helpers --------------------------------------------------

def _poisson_at_least(mean: float, k: int) -> float:
    """P(X >= k) for X ~ Poisson(mean)."""
    term, cdf = math.exp(-mean), 0.0
    for i in range(k):
        cdf += term
        term *= mean / (i + 1)
    return max(0.0, 1.0 - cdf)


def _count_at_least(mean: float, k: int, vmr: float) -> float:
    """P(X >= k) for a count with this mean and variance/mean ratio: Poisson when vmr <= 1, otherwise
    negative binomial (defensive actions come in bursts: some games a defender is under siege)."""
    if vmr <= 1.0 or mean <= 0:
        return _poisson_at_least(mean, k)
    r = mean / (vmr - 1.0)            # NB "size": variance = mean + mean^2 / r
    q = r / (r + mean)                # P(X = 0) = q^r
    term, cdf = q ** r, 0.0
    for i in range(k):
        cdf += term
        term *= (i + r) / (i + 1) * (1 - q)
    return max(0.0, 1.0 - cdf)


def _expected_thirds(mean: float) -> float:
    """E[floor(S/3)] for S ~ Poisson(mean): 1 FPL point per 3 saves, so 2 saves score nothing."""
    total, term = 0.0, math.exp(-mean)
    for k in range(0, 30):
        if k:
            term *= mean / k
        total += (k // 3) * term
    return total


def _expected_half_goals(lam: float) -> float:
    """E[floor(GC/2)] for GC ~ Poisson(lam): the GK/DEF deduction is -1 per 2 goals conceded, which is
    less than lam/2 (1 goal conceded costs nothing)."""
    total, term = 0.0, math.exp(-lam)
    for k in range(0, 16):
        if k:
            term *= lam / k
        total += (k // 2) * term
    return total


def defcon_rates(elements: list[dict], last: dict[str, dict] | None = None) -> dict[int, float]:
    """{fpl_id: DefCon actions per 90}, shrunk toward the position average. From FPL bootstrap, which
    counts CBIT for defenders and CBIRT for midfielders/forwards: the same count the threshold uses.
    `last` (last-season profiles by player code) adds last season's actions and minutes at DEFCON_LAST_W,
    so early-season rates aren't near zero; ignored when last season had no DefCon (before 2025/26)."""
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    use_last = bool(last) and DEFCON_LAST_W > 0 and sum(p.get("dc", 0) for p in last.values()) > 0
    totals = {}
    for e in elements:
        dc, mins = float(e.get("defensive_contribution") or 0), float(e.get("minutes") or 0)
        lp = last.get(str(e.get("code"))) if use_last else None
        if lp:
            dc += DEFCON_LAST_W * lp.get("dc", 0)
            mins += DEFCON_LAST_W * lp.get("minutes", 0)
        totals[e["id"]] = (pos[e["element_type"]], dc, mins)
    agg: dict[str, list[float]] = {}
    for p, dc, mins in totals.values():
        a = agg.setdefault(p, [0.0, 0.0])
        a[0] += dc
        a[1] += mins
    base = {p: (dc / (m / 90.0) if m else 0.0) for p, (dc, m) in agg.items()}
    return {i: (dc + DEFCON_K * base[p]) / (mins / 90.0 + DEFCON_K) for i, (p, dc, mins) in totals.items()}


def form4(entries: list[dict], last: dict | None) -> float:
    """His average FPL points over his club's last 4 GWs this season; before he has any, last season's
    points per game (0 for a newcomer)."""
    recent = sorted(entries, key=lambda e: e["age"])[:4]
    if recent:
        return sum(e.get("pts", 0) for e in recent) / len(recent)
    return last["pts"] / last["rows"] if last and last.get("rows") else 0.0


# --- base-rate blending ------------------------------------------------------

# --- core projection ---------------------------------------------------------

def project_fixture(player: dict, prof: dict, lam_for: float, lam_against: float, base_for: float,
                    base_against: float, is_home: bool, form_mult: float = 1.0,
                    opp_mult: float = 1.0, rotation: float = 1.0, extras: dict | None = None) -> dict:
    """One player, one fixture -> component dict of expected points.

    `prof` is the player's form profile (form_model.form_profile + dc90). `form_mult` is a
    small preseason-form multiplier on attacking output (2026 World Cup — see form.py); 1.0 = no
    change. It scales the attacking rates only, so it flows through goals, assists, and bonus.

    `lam_for` / `lam_against` are this fixture's expected goals for and against the player's team
    (team_model). His expected goals = his share of team xG x lam_for x home/away multiplier x minutes;
    `base_for` / `base_against` (the team's expected goals for/against an average opponent) are only used
    to express how favourable the fixture is and to scale bonus."""
    pos = player["position"] or "MID"
    gs = max(0.6, 1.0 - GAME_STATE * max(0.0, lam_for - lam_against))
    extras = extras or {}
    p_start, p_play, exp_min, p_60, p_start0 = _minutes(player, gs, rotation, extras.get("lineup"))
    mins_frac = exp_min / 90.0
    adj = lam_for / base_for if base_for else 1.0
    home = prof["home_mult"][is_home]

    # his expected goals per 90 in THIS fixture; opp_mult: how this opponent's conceded chances fall to his position
    xg90 = prof["xg_share"] * lam_for * home * form_mult * opp_mult
    xa90 = prof["xa_share"] * lam_for * home * form_mult * opp_mult
    yellow90 = prof["yellow90"]

    x_goals = xg90 * mins_frac
    x_assists = xa90 * mins_frac
    # Live-only set-piece duties (learned weights): penalties, corners / indirect FKs, direct FKs.
    team_scale = lam_for / extras["lam_avg"] if extras.get("lam_avg") else 1.0
    pen_term = PEN_RATE * team_scale * mins_frac * PEN_CONVERSION if extras.get("pen") else 0.0
    sp_xa = CORNER_XA90 * team_scale * mins_frac if extras.get("corner") else 0.0
    sp_xg = FK_XG90 * team_scale * mins_frac if extras.get("fk") else 0.0
    base_goals, base_assists = x_goals, x_assists
    x_goals += FACTOR_WEIGHTS["penalty"] * pen_term + FACTOR_WEIGHTS["setpiece"] * sp_xg
    x_assists += FACTOR_WEIGHTS["setpiece"] * sp_xa
    x_goals_pts = x_goals * GOAL_PTS[pos]
    x_assist_pts = x_assists * ASSIST_PTS

    # clean sheet, saves and goals-conceded deductions all use the fixture's expected goals against
    lam = lam_against
    # P(clean sheet): Poisson zero, mixed over uncertainty in lam (gamma, CS_DISP) — an uncertain lam makes
    # a shut-out likelier than exp(-lam) (Jensen), which plain Poisson understated in the backtest.
    p_cs = (1 + CS_DISP * lam) ** (-1 / CS_DISP) if CS_DISP > 0 else math.exp(-lam)
    x_cs_pts = p_cs * CS_PTS[pos] * p_60

    # appearance
    x_appearance_pts = p_play * 1.0 + p_60 * 1.0

    # saves (GK, rough)
    if pos != "GK":
        x_saves_pts = 0.0
    elif SAVES_PER_XGA is None:
        x_saves_pts = (lam * 2.0 / 3.0) * p_start
    else:  # saves scale with the chances he faces; only whole sets of 3 score
        x_saves_pts = _expected_thirds(SAVES_PER_XGA * lam) * p_start

    # defensive contributions: P(reaching the threshold in a start) from the player's per-90 rate
    thr = DEFCON_THRESHOLD.get(pos)
    p_dc = _count_at_least(prof.get("dc90", 0.0) * 82 / 90, thr, DEFCON_VMR) if thr else 0.0
    x_defcon_pts = DEFCON_PTS * p_dc * p_start

    # bonus: his own bonus rate, scaled by how the fixture suits his role (attack for MID/FWD, clean
    # sheet for GK/DEF). BONUS_MODEL = False keeps the old involvement proxy for comparison.
    if BONUS_MODEL:
        fx = adj if pos in ("MID", "FWD") else (p_cs / math.exp(-base_against) if base_against else 1.0)
        x_bonus_pts = prof["bonus90"] * mins_frac * fx
    else:
        involvement = x_goals_pts + x_assist_pts + (x_cs_pts if pos in ("GK", "DEF") else 0.0)
        x_bonus_pts = min(1.5, 0.25 * involvement)

    # deductions: goals conceded (GK/DEF -1 per 2) + yellow cards
    x_conceded = -_expected_half_goals(lam) * p_start if pos in ("GK", "DEF") else 0.0
    x_cards = -(yellow90 * mins_frac)
    x_deductions_pts = x_conceded + x_cards

    x_pts = (
        x_appearance_pts + x_goals_pts + x_assist_pts + x_cs_pts
        + x_saves_pts + x_defcon_pts + x_bonus_pts + x_deductions_pts
    )
    return {
        "x_pts": x_pts,
        "x_appearance_pts": x_appearance_pts,
        "x_goals_pts": x_goals_pts,
        "x_assist_pts": x_assist_pts,
        "x_cs_pts": x_cs_pts,
        "x_saves_pts": x_saves_pts,
        "x_defcon_pts": x_defcon_pts,
        "x_bonus_pts": x_bonus_pts,
        "x_deductions_pts": x_deductions_pts,
        "p_start": p_start,
        "p_play": p_play,
        "p_start0": p_start0,
        "p_60": p_60,
        "f": {"penalty": {"base": base_goals, "term": pen_term} if pen_term else None,
              "setpiece": {"base": base_goals + base_assists, "term": sp_xa + sp_xg} if (sp_xa or sp_xg) else None,
              "lineup": ({"base": p_start0, "term": extras["lineup"][1] * (LINEUP_TARGET[extras["lineup"][0]] - p_start0)}
                         if extras.get("lineup") else None)},
        "p_dc": p_dc,
        "exp_minutes": exp_min,
        "fixture_adj": adj,
        "p_cs": p_cs,
        "xg90": xg90,
        "xa90": xa90,
    }


# Component columns scaled by the per-position calibration multiplier (keeps x_pts = sum of parts).
_CALIB_FIELDS = (
    "x_pts", "x_appearance_pts", "x_goals_pts", "x_assist_pts", "x_cs_pts",
    "x_saves_pts", "x_defcon_pts", "x_bonus_pts", "x_deductions_pts",
)


def _load_calibration(sb) -> dict[str, float]:
    """Per-position multiplier learned from past accuracy (predict.py). Empty (=> no change) until
    gameweeks have been scored, or if the migration isn't applied yet."""
    try:
        rows = sb.table("model_calibration").select("position, multiplier").execute().data
        return {r["position"]: float(r["multiplier"]) for r in rows}
    except Exception:  # noqa: BLE001 — table may not exist yet; projections must still run
        return {}


def _load_news(sb) -> dict[int, dict]:
    """Latest news signal per player (news_sentiment is replaced wholesale by each news_job run)."""
    try:
        rows = sb.table("news_sentiment").select(
            "player_id, sentiment, topics, summary, minutes_risk_adj, published_at, source").execute().data
    except Exception:  # noqa: BLE001 — news is an enhancement; projections must still run
        return {}
    out: dict[int, dict] = {}
    for r in rows:
        cur = out.get(r["player_id"])
        if cur is None or (r.get("published_at") or "") > (cur.get("published_at") or ""):
            out[r["player_id"]] = r
    return out


def _load_params(sb) -> dict[str, float]:
    """Learned model parameters (model_params, migration 0008): e.g. news_weight. Empty -> defaults."""
    try:
        return {r["key"]: float(r["value"]) for r in sb.table("model_params").select("key, value").execute().data}
    except Exception:  # noqa: BLE001 — table may not exist yet
        return {}


def _load_table(sb, table: str, cols: str, eq: tuple | None = None) -> list[dict]:
    """Rows from an optional table (migration 0009); [] if it doesn't exist yet."""
    try:
        q = sb.table(table).select(cols)
        if eq:
            q = q.eq(*eq)
        return q.execute().data
    except Exception:  # noqa: BLE001
        return []


def _manager_reset_ages(ctx: list[dict], fixtures: list[dict]) -> dict[int, int]:
    """{team_id: age in GWs at/after which games were under the previous manager} for recent changes."""
    finished = sorted({f["gw"] for f in fixtures if f["finished"] and f["gw"] is not None})
    if not finished:
        return {}
    latest = finished[-1]
    out = {}
    for c in ctx:
        if not c.get("manager_changed_at"):
            continue
        after = [f["gw"] for f in fixtures if f["gw"] is not None and f.get("kickoff_time")
                 and f["kickoff_time"][:10] >= str(c["manager_changed_at"])
                 and c["team_id"] in (f["team_h"], f["team_a"])]
        first_gw = min(after) if after else latest + 1
        out[c["team_id"]] = latest - first_gw + 1
    return out


def return_ramp(hist: list[dict], player: dict) -> dict | None:
    """Factor 5: a regular starter who has missed his club's last RETURN_MIN_ABSENT+ games but is now fully
    available (FPL flag clear) restarts from RETURN_RAMP of his pre-absence start rate, instead of the near-zero
    rate his recent zeros imply. Returns {base, ramp, absent} or None."""
    if player["status"] != "a" or (player["chance_of_playing_next_round"] or 100) < 75:
        return None
    by_age = sorted(hist, key=lambda h: h["age"])
    absent = 0
    for h in by_age:
        if h["minutes"] > 0:
            break
        absent += 1
    if absent < RETURN_MIN_ABSENT:
        return None
    before = [dict(h, age=h["age"] - absent) for h in by_age[absent:] if h["age"] - absent < MINUTES_WINDOW]
    pre = minutes_profile(before, None)["start_rate"] if before else 0.0
    if pre < RETURN_PRE_RATE:
        return None
    base = player["mprof"]["start_rate"]
    return {"base": round(base, 3), "ramp": round(pre * RETURN_RAMP, 3), "absent": absent}


def _load_form(sb) -> dict[int, float]:
    """Preseason (World Cup) form multipliers by fpl_id (form.py). Empty (=> no change) if the table
    isn't there yet. A small, bounded nudge to attacking output until the domestic season starts."""
    try:
        rows = sb.table("preseason_form").select("player_id, form_mult").execute().data
        return {r["player_id"]: float(r["form_mult"]) for r in rows}
    except Exception:  # noqa: BLE001 — table may not exist yet; projections must still run
        return {}


def _club_games(fixtures: list[dict]) -> dict[tuple[int, int], int]:
    """{(team_id, gw): fixtures that club played that GW} over finished fixtures."""
    games: dict[tuple[int, int], int] = {}
    for f in fixtures:
        if f["finished"] and f["gw"] is not None:
            for t in (f["team_h"], f["team_a"]):
                games[(t, f["gw"])] = games.get((t, f["gw"]), 0) + 1
    return games


def fetch_live(client: FplClient, fixtures: list[dict]) -> dict[int, list[dict]]:
    """{gw: event/{gw}/live elements} for every finished GW (one call each). Feeds both the minutes
    model (last MINUTES_WINDOW GWs) and this season's team xG for the team goals model."""
    return {gw: client.event_live(gw).get("elements", [])
            for gw in sorted({gw for (_, gw) in _club_games(fixtures)})}


def season_entries(live: dict[int, list[dict]], fixtures: list[dict],
                   team_by_player: dict[int, int]) -> dict[int, list[dict]]:
    """{player_id: [{age, games, starts, minutes, xg, xa, bonus, yellow, team_xg_on, home}, ...]} for every
    finished GW this season (same shape as fpl_history.entries_before in the backtest). Only GWs where the
    player's CURRENT club played count, so a blank isn't read as being dropped. team_xg_on = the club's
    xG that GW x his share of its minutes."""
    games = _club_games(fixtures)
    home_of: dict[tuple[int, int], bool] = {}
    for f in fixtures:
        if f["finished"] and f["gw"] is not None:
            home_of[(f["team_h"], f["gw"])] = True
            home_of[(f["team_a"], f["gw"])] = False
    latest = max(live) if live else 0
    out: dict[int, list[dict]] = {}
    for gw, elements in live.items():
        team_xg: dict[int, float] = {}
        for e in elements:
            t = team_by_player.get(e["id"])
            team_xg[t] = team_xg.get(t, 0.0) + float(e["stats"].get("expected_goals") or 0)
        for e in elements:
            t = team_by_player.get(e["id"])
            n = games.get((t, gw), 0)
            if not n:
                continue
            st = e["stats"]
            mins = st.get("minutes") or 0
            out.setdefault(e["id"], []).append({
                "age": latest - gw, "games": n, "starts": st.get("starts") or 0, "minutes": mins,
                "xg": float(st.get("expected_goals") or 0), "xa": float(st.get("expected_assists") or 0),
                "bonus": st.get("bonus") or 0, "yellow": st.get("yellow_cards") or 0,
                "bps": st.get("bps") or 0, "goals": st.get("goals_scored") or 0, "assists": st.get("assists") or 0,
                "cs": st.get("clean_sheets") or 0, "gc": st.get("goals_conceded") or 0,
                "mbps": 6 if mins >= 60 else 3 if mins > 0 else 0, "pts": st.get("total_points") or 0,
                "team_xg_on": team_xg.get(t, 0.0) * mins / (90.0 * n),
                "home": home_of.get((t, gw)) if n == 1 else None,
            })
    return out


def season_team_matches(live: dict[int, list[dict]], fixtures: list[dict], team_by_player: dict[int, int],
                        name_by_id: dict[int, str]) -> list[dict]:
    """This season's finished matches with each side's xG, for the team goals model. A club's xG in a
    GW is the sum of its players' FPL expected_goals (event/{gw}/live), split evenly if it played twice.
    Players are credited to their current club, so a mid-season transfer's earlier xG moves with him."""
    games = _club_games(fixtures)
    xg: dict[tuple[int, int], float] = {}
    for gw, elements in live.items():
        for e in elements:
            t = team_by_player.get(e["id"])
            if t is not None:
                xg[(t, gw)] = xg.get((t, gw), 0.0) + float(e["stats"].get("expected_goals") or 0)
    out = []
    for f in fixtures:
        if not f["finished"] or f["gw"] is None or not f.get("kickoff_time"):
            continue
        h, a, gw = f["team_h"], f["team_a"], f["gw"]
        out.append({"home": name_by_id[h], "away": name_by_id[a],
                    "hxg": xg.get((h, gw), 0.0) / games[(h, gw)], "axg": xg.get((a, gw), 0.0) / games[(a, gw)],
                    "date": datetime.fromisoformat(f["kickoff_time"].replace("Z", "+00:00"))})
    return out


def next_gameweek(boot: dict) -> int | None:
    """The next gameweek whose deadline hasn't passed (FPL's is_next). Taken from FPL rather than
    'lowest GW with an unfinished fixture', which would keep projecting a GW already in progress."""
    return next((e["id"] for e in boot.get("events", []) if e.get("is_next")), None)


def run(sb, horizon: int = 5, dry_run: bool = False) -> None:
    players = (
        sb.table("players")
        .select("fpl_id, code, web_name, position, team_id, status, "
                "chance_of_playing_next_round, minutes, now_cost, expected_goals, expected_assists, "
                "expected_goals_conceded")
        .execute()
        .data
    )
    teams = sb.table("teams").select("fpl_id, name, short_name").execute().data
    fixtures = (
        sb.table("fixtures")
        .select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, finished, kickoff_time")
        .execute()
        .data
    )

    # Strengths re-tuned weekly (tune.py) and factor weights learned from outcomes (predict.py).
    params = _load_params(sb)
    for key, (mod, attr) in TUNED_PARAMS.items():
        if key in params:
            setattr(mod, attr, params[key])

    # Last season from the FPL dataset (fpl_history), matched by FPL's stable player `code` — the same
    # source the backtest replays, so what's measured is what runs.
    first_kickoff = min(f["kickoff_time"] for f in fixtures if f.get("kickoff_time"))
    prev = fpl_history.load_season(fpl_history.prev_season(fpl_history.season_of(int(first_kickoff[:4]))))
    profiles = fpl_history.last_season_profiles(prev)
    base = form_model.base_rates(profiles)
    if dry_run:
        print("Position averages (shrinkage prior): " + ", ".join(
            f"{pos} xG share {b['xg_share']:.3f} bonus/90 {b['bonus90']:.2f}" for pos, b in base.items()))
    team_by_player = {p["fpl_id"]: p["team_id"] for p in players}
    name_by_id = {t["fpl_id"]: t["name"] for t in teams}
    with FplClient() as client:
        boot = client.bootstrap_static()
        live = fetch_live(client, fixtures)
    history = season_entries(live, fixtures, team_by_player)
    dc90 = defcon_rates(boot["elements"], profiles)
    elem = {e["id"]: e for e in boot["elements"]}
    total_managers = boot.get("total_players") or 0

    # Team goals model: fit strengths on last season's match xG + this season's FPL xG, then blend each
    # upcoming fixture with bookmaker odds where they're published.
    last_matches = fpl_history.season_matches(prev)
    matches = last_matches + season_team_matches(live, fixtures, team_by_player, name_by_id)
    names = [t["name"] for t in teams]
    promoted = set(names) - {m["home"] for m in last_matches}
    all_teams = sorted(set(names) | {m["home"] for m in matches} | {m["away"] for m in matches})
    strengths = team_model.fit(matches, datetime.now(timezone.utc), all_teams, promoted)
    odds = team_model.upcoming_odds(names)
    base_for = {t["fpl_id"]: team_model.average_goals_for(strengths, t["name"]) for t in teams}
    base_against = {t["fpl_id"]: team_model.average_goals_against(strengths, t["name"]) for t in teams}

    # Match context: opponent-vs-position ratios (last season + this season) and each club's match dates
    # across all competitions (league fixtures + ESPN cup/European fixtures near the upcoming GWs).
    pos_by_player = {p["fpl_id"]: p["position"] for p in players}
    opp_of = {}
    for f in fixtures:
        if f["gw"] is not None:
            opp_of.setdefault((f["team_h"], f["gw"]), []).append(name_by_id[f["team_a"]])
            opp_of.setdefault((f["team_a"], f["gw"]), []).append(name_by_id[f["team_h"]])
    records = [(r.opp_name, r.pos, r.expected_goals + r.expected_assists, f"p{r.fixture}")
               for r in prev.assign(opp_name=prev["opponent_team"].map(
                   {int(t.id): t.name for t in fpl_history.teams(fpl_history.prev_season(
                       fpl_history.season_of(int(first_kickoff[:4])))).itertuples(index=False)})).itertuples(index=False)]
    for gw, elements in live.items():
        for e in elements:
            t = team_by_player.get(e["id"])
            opps = opp_of.get((t, gw), [])
            if len(opps) == 1 and pos_by_player.get(e["id"]):
                xgi = float(e["stats"].get("expected_goals") or 0) + float(e["stats"].get("expected_assists") or 0)
                records.append((opps[0], pos_by_player[e["id"]], xgi, f"c{gw}-{t}"))
    opp_ratios = context_model.opp_position_ratios(records)
    league_dates = [(name_by_id[t], f["kickoff_time"]) for f in fixtures if f.get("kickoff_time")
                    for t in (f["team_h"], f["team_a"])]
    print(f"Team model: {len(matches)} matches, home advantage x{math.exp(strengths['home']):.2f}, "
          f"odds for {len(odds)} upcoming fixtures.")
    short_by_id = {t["fpl_id"]: t["short_name"] for t in teams}
    form = _load_form(sb)  # small preseason (World Cup) form nudge; {} until form.py populates it

    next_gw = next_gameweek(boot)
    if next_gw is None:
        print("No upcoming gameweek (season over?).")
        return
    gws = list(range(next_gw, min(next_gw + horizon, LAST_GW + 1)))
    upcoming = [f for f in fixtures if not f["finished"] and f["gw"] is not None]
    # Other competitions only matter near the next few GWs (cup draws further out aren't known yet).
    soon = sorted(f["kickoff_time"] for f in upcoming if f.get("kickoff_time") and f["gw"] < next_gw + CONGESTION_GWS)
    other = schedules.fetch(*context_model.season_window(soon[0], soon[-1])) if soon and context_model.CONGESTION else []
    dates_by_team = schedules.team_dates(other, league_dates, names)

    # Games each club has played so far this season — the denominator for this season's minutes share.
    team_games: dict[int, int] = {}
    for f in fixtures:
        if f["finished"]:
            for t in (f["team_h"], f["team_a"]):
                team_games[t] = team_games.get(t, 0) + 1

    # index fixtures by (team_id, gw) -> list of (is_home, xg_for, xg_against, opp_team_id, has_odds).
    # (The custom FDR stays for display on the Fixtures page; the model uses these expected goals.)
    by_team_gw: dict[tuple[int, int], list] = {}
    for f in upcoming:
        if f["gw"] not in gws:
            continue
        hn, an = name_by_id[f["team_h"]], name_by_id[f["team_a"]]
        mkt = odds.get((hn, an))
        lam_h, lam_a = team_model.blend(team_model.model_goals(strengths, hn, an), mkt)
        day = datetime.fromisoformat(f["kickoff_time"].replace("Z", "+00:00")).date() if f.get("kickoff_time") else None
        rot_h = context_model.rotation_factor(dates_by_team.get(hn, []), day) if day else (1.0, None)
        rot_a = context_model.rotation_factor(dates_by_team.get(an, []), day) if day else (1.0, None)
        by_team_gw.setdefault((f["team_h"], f["gw"]), []).append((True, lam_h, lam_a, f["team_a"], mkt is not None, rot_h))
        by_team_gw.setdefault((f["team_a"], f["gw"]), []).append((False, lam_a, lam_h, f["team_h"], mkt is not None, rot_a))

    global NEWS_WEIGHT
    NEWS_WEIGHT = params.get("news_weight", NEWS_WEIGHT)
    for k in FACTOR_WEIGHTS:
        FACTOR_WEIGHTS[k] = params.get(f"{k}_weight", FACTOR_WEIGHTS[k])
    lineup_rows = _load_table(sb, "predicted_lineups", "player_id, predicted, confidence", ("gw", next_gw))
    lineup = {r["player_id"]: (bool(r["predicted"]), float(r["confidence"] or 0)) for r in lineup_rows}
    reset_age = _manager_reset_ages(_load_table(sb, "team_context", "team_id, manager_changed_at"), fixtures)
    lam_avg = sum(base_for.values()) / len(base_for)
    news = _load_news(sb)
    now = datetime.now(timezone.utc)

    rows = []
    rng = np.random.default_rng(next_gw)  # fixed seed per GW: ranges don't jitter between runs
    for p in players:
        last = profiles.get(str(p["code"])) if p.get("code") is not None else None
        hist = history.get(p["fpl_id"], [])
        ra = reset_age.get(p["team_id"])
        prof = form_model.form_profile(hist, last, base[p["position"]], reset_age=ra)
        prof["dc90"] = dc90.get(p["fpl_id"], 0.0)
        recent_hist = [h for h in hist if h["age"] < MINUTES_WINDOW and (ra is None or h["age"] < ra)]
        p["mprof"] = minutes_profile(recent_hist, last["minutes"] if last and ra is None else None)
        ret = return_ramp(hist, p)
        if ret:
            p["mprof"]["start_rate"] += FACTOR_WEIGHTS["return"] * (ret["ramp"] - ret["base"])
        e = elem.get(p["fpl_id"], {})
        extras = {"pen": e.get("penalties_order") == 1, "corner": e.get("corners_and_indirect_freekicks_order") == 1,
                  "fk": e.get("direct_freekicks_order") == 1, "lam_avg": lam_avg}
        p["news_adj"] = news_adjustment(news.get(p["fpl_id"]), now)
        avail, fpl_avail = availability(p)
        f4 = form4(hist, last)
        recent = [h for h in hist if h["age"] < 5]
        # Explanation inputs stored on every projection (the web's "i" pop-up turns these into bullets).
        why = {
            "start_rate": round(p["mprof"]["start_rate"], 3), "p60_start": round(p["mprof"]["p60_start"], 3),
            "recent_starts": sum(h["starts"] for h in recent), "recent_games": sum(h["games"] for h in recent),
            "recent_minutes": sum(h["minutes"] for h in recent),
            "fpl_avail": round(fpl_avail, 2), "news_adj": round(p["news_adj"], 3), "avail": round(avail, 3),
            "xg_share": round(prof["xg_share"], 3), "xa_share": round(prof["xa_share"], 3),
            "bonus90": round(prof["bonus90"], 3), "dc90": round(prof["dc90"], 2), "form4": round(f4, 2),
            "home_mult": {"home": round(prof["home_mult"][True], 3), "away": round(prof["home_mult"][False], 3)},
            "return": ret, "manager_reset": ra is not None,
            "setpieces": {"pen": extras["pen"], "corner": extras["corner"], "fk": extras["fk"]},
            "price": price_model.price_signal(elem.get(p["fpl_id"], {}).get("transfers_in_event") or 0,
                                              elem.get(p["fpl_id"], {}).get("transfers_out_event") or 0,
                                              float(elem.get(p["fpl_id"], {}).get("selected_by_percent") or 0),
                                              total_managers),
            "season": {"xg": round(sum(h["xg"] for h in hist), 2), "xa": round(sum(h["xa"] for h in hist), 2),
                       "min": int(sum(h["minutes"] for h in hist))},
            "last": ({"xg": round(last["xg"], 2), "xa": round(last["xa"], 2), "min": int(last["minutes"])}
                     if last else None),
        }
        # World Cup form is a preseason stand-in; once the club has played, real minutes/xG take over.
        fm = form.get(p["fpl_id"], 1.0) if team_games.get(p["team_id"], 0) == 0 else 1.0
        for gw in gws:
            fxs = by_team_gw.get((p["team_id"], gw), [])
            if not fxs:
                continue  # blank GW for this team
            agg: dict[str, float] = {}
            samples = np.zeros(outcomes.N)  # range of outcomes: simulated GW totals (outcomes.py)
            opp_short = []
            xg_for, xg_against, with_odds, atk_mult, p_cs, opp_pos, rest_days = [], [], [], [], [], [], []
            for is_home, lam_for, lam_against, opp_id, has_odds, (rot, gap) in fxs:
                om = context_model.opp_multiplier(opp_ratios, name_by_id[opp_id], p["position"])
                fx_extras = {**extras, "lineup": lineup.get(p["fpl_id"]) if gw == next_gw else None}
                comp = project_fixture(p, prof, lam_for, lam_against, base_for[p["team_id"]],
                                       base_against[p["team_id"]], is_home, form_mult=fm, opp_mult=om,
                                       rotation=rot, extras=fx_extras)
                if FORM_BLEND:
                    # Recent-points blend: shrink the components by a, add b·form4 + c (only as available as
                    # he is — an injured player's past points don't score this week). Shown as "Recent form".
                    a, b, c = FORM_BLEND[p["position"]]
                    for k in _CALIB_FIELDS[1:]:
                        comp[k] *= a
                    parts = sum(comp[k] for k in _CALIB_FIELDS[1:])
                    comp["x_form_pts"] = max(avail * (b * f4 + c), -parts)
                    comp["x_pts"] = parts + comp["x_form_pts"]
                samples += outcomes.sample_fixture(comp, p["position"], lam_against, prof["yellow90"], rng,
                                                   GOAL_PTS[p["position"]], CS_PTS[p["position"]], SAVES_PER_XGA)
                opp_pos.append(round(om, 3))
                rest_days.append(gap)
                xg_for.append(round(lam_for, 2))
                xg_against.append(round(lam_against, 2))
                with_odds.append(has_odds)
                atk_mult.append(round(comp["fixture_adj"], 3))
                p_cs.append(round(comp["p_cs"], 3))
                f_terms = {k: ({kk: round(vv, 4) for kk, vv in v.items()} if v else None) for k, v in comp["f"].items()}
                if ret:  # start-rate level: without the ramp, and what the ramp adds at weight 1
                    f_terms["return"] = {"base": ret["base"], "term": round(ret["ramp"] - ret["base"], 4)}
                fx_why = {"p_start": round(comp["p_start"], 3), "p_60": round(comp["p_60"], 3), "f": f_terms,
                          "lineup": list(fx_extras["lineup"]) if fx_extras["lineup"] else None,
                          "exp_minutes": round(comp["exp_minutes"], 1), "p_dc": round(comp["p_dc"], 3)}
                for k, v in comp.items():
                    if k in ("p_start", "p_play", "p_start0", "p_60", "p_dc", "exp_minutes", "fixture_adj", "p_cs", "xg90", "xa90", "f"):
                        continue
                    agg[k] = agg.get(k, 0.0) + v
                opp_short.append(("" if is_home else "@") + short_by_id.get(opp_id, "?"))
            rows.append({
                "player_id": p["fpl_id"],
                "gw": gw,
                "x_pts": round(agg["x_pts"], 3),
                "x_appearance_pts": round(agg["x_appearance_pts"], 3),
                "x_goals_pts": round(agg["x_goals_pts"], 3),
                "x_assist_pts": round(agg["x_assist_pts"], 3),
                "x_cs_pts": round(agg["x_cs_pts"], 3),
                "x_saves_pts": round(agg["x_saves_pts"], 3),
                "x_defcon_pts": round(agg["x_defcon_pts"], 3),
                "x_bonus_pts": round(agg["x_bonus_pts"], 3),
                "x_deductions_pts": round(agg["x_deductions_pts"], 3),
                "model_version": MODEL_VERSION,
                "components": {"opponents": opp_short, "n_fixtures": len(fxs), "form": round(fm, 3),
                               "team_xg_for": xg_for, "team_xg_against": xg_against, "odds": with_odds,
                               "atk_mult": atk_mult, "p_cs": p_cs, "opp_pos": opp_pos, "rest_days": rest_days,
                               "form_pts": round(agg.get("x_form_pts", 0.0), 3),
                               **fx_why, "why": why},
                "_web_name": p["web_name"],
                "_pos": p["position"],
                "_cost": p["now_cost"],
                "_opp": ",".join(opp_short),
                "_samples": samples,
            })

    # Transparent calibration: scale each projection by its position's learned multiplier so
    # systematic over/under-prediction is corrected going forward. Identity (×1.0) until scored.
    calib = _load_calibration(sb)
    if calib:
        for r in rows:
            m = calib.get(r["_pos"], 1.0)
            if m != 1.0:
                for k in _CALIB_FIELDS:
                    r[k] = round(r[k] * m, 3)
            r["components"]["calibration"] = round(m, 3)
    # Floor / median / ceiling and haul / blank chances, on the same calibrated scale as x_pts.
    for r in rows:
        r["components"]["range"] = outcomes.summarise(r.pop("_samples") * calib.get(r["_pos"], 1.0))

    if dry_run:
        _print_top(rows, next_gw)
        return

    payload = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    # Replace this model's rows wholesale: rewrite the window AND drop gameweeks that have started, so
    # every reader's "lowest GW in projections" is always the real next gameweek.
    sb.table("projections").delete().eq("model_version", MODEL_VERSION).in_("gw", gws).execute()
    sb.table("projections").delete().eq("model_version", MODEL_VERSION).lt("gw", next_gw).execute()
    # Only one model version is ever served; drop rows from older versions so nothing reads stale ones.
    sb.table("projections").delete().neq("model_version", MODEL_VERSION).execute()
    db.upsert(sb, "projections", payload, on_conflict="player_id,gw,model_version")
    print(f"Wrote {len(payload)} projections for GW{next_gw}-{gws[-1]} (model {MODEL_VERSION}).")


def _print_top(rows: list[dict], gw: int) -> None:
    this_gw = [r for r in rows if r["gw"] == gw]
    this_gw.sort(key=lambda r: r["x_pts"], reverse=True)
    print(f"\nTop 25 projected for GW{gw} (model {MODEL_VERSION}):")
    print(f"{'player':16}{'pos':5}{'£':6}{'opp':8}{'xPts':>6}  {'gls':>5}{'ast':>5}{'cs':>5}{'app':>5}")
    for r in this_gw[:25]:
        print(f"{r['_web_name'][:15]:16}{r['_pos']:5}{r['_cost']/10:<6}{r['_opp'][:7]:8}"
              f"{r['x_pts']:6.2f}  {r['x_goals_pts']:5.2f}{r['x_assist_pts']:5.2f}"
              f"{r['x_cs_pts']:5.2f}{r['x_appearance_pts']:5.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Rules-based xPts model (Phase 3).")
    parser.add_argument("--run", action="store_true", help="write projections to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="compute + print, no DB write")
    parser.add_argument("--horizon", type=int, default=5, help="number of gameweeks (default 5)")
    args = parser.parse_args()

    load_dotenv()
    sb = db.get_client()
    run(sb, horizon=args.horizon, dry_run=args.dry_run or not args.run)


if __name__ == "__main__":
    main()
