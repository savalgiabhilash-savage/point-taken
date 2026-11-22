"""Team goals model (accuracy plan step 2): each side's expected goals in each fixture.

Two sources, blended:

1. A fitted team-strength model (Maher / Dixon-Coles style, on xG rather than goals — xG is the more
   stable signal). For a match of home team i against away team j:
       E[home xG] = exp(mu + home + att_i + def_j)
       E[away xG] = exp(mu + att_j + def_i)
   `att` is how much a team creates, `def` how much it concedes (higher = leakier), both relative to an
   average team; `home` is the home advantage. Every past match is weighted 0.5 ** (age_days /
   HALF_LIFE_DAYS), so recent form counts most while last season still anchors the early weeks. Each
   team's att/def is also pulled toward a prior by PRIOR_MATCHES virtual matches: 0 (average) for
   established clubs, a weak-team prior for clubs without data (promoted sides).

2. Bookmaker odds (football-data.co.uk: market-average 1X2 and over/under 2.5). With the bookmaker margin
   removed, the over/under price fixes the expected total goals and the 1X2 prices fix how it splits
   between the sides (odds_to_goals). Markets price in team news and injuries, which the xG model can't see.

Where odds exist:  lam = ODDS_WEIGHT * lam_odds + (1 - ODDS_WEIGHT) * lam_model; otherwise lam_model.
Both parameters were tuned on the 2023-24 backtest (see backtest.py).
"""

from __future__ import annotations

import io
import math
from datetime import datetime

import httpx
import pandas as pd

HALF_LIFE_DAYS = 90.0   # tuned on 2023-24 (90 beat 60, 180, 365)
PRIOR_MATCHES = 3.0
PROMOTED_PRIOR = {"att": -0.25, "def": 0.25}  # roughly the weakest returning side
ODDS_WEIGHT = 0.75     # tuned on 2023-24 (0.5-1.0 all close; 0.75 best MAE)
FIT_ITERATIONS = 40
# One-off blowouts: a side's xG above XG_CAP in a single match only counts XG_OVER of the excess, so
# one 5-xG game can't define a team's attack for months. None = off.
XG_CAP: float | None = 3.0   # tuned on 2023-24 (2.0-3.0 tested; RMSE unchanged, 3.0 best top-20 / captain)
XG_OVER = 0.5

# football-data.co.uk names that differ from FPL's; others match exactly or as a prefix
# ("Coventry" -> "Coventry City"), which FPL uses for some seasons' promoted clubs but not others.
FD_ALIASES = {"Man United": "Man Utd", "Tottenham": "Spurs", "Sheffield United": "Sheffield Utd"}
FD_BASE = "https://football-data.co.uk"
FD_UPCOMING = f"{FD_BASE}/fixtures.csv"


# --- fitting --------------------------------------------------------------------------------------

def _damp(x: float) -> float:
    """Soft cap on one side's xG in one match (see XG_CAP)."""
    return x if XG_CAP is None or x <= XG_CAP else XG_CAP + XG_OVER * (x - XG_CAP)


def fit(matches: list[dict], ref: datetime, teams: list[str], promoted: set[str] | None = None) -> dict:
    """matches: {home, away, hxg, axg, date (datetime)}; returns {mu, home, att: {team}, def: {team}}.

    Fitted by alternating closed-form updates (each team's attack = its weighted xG created divided by
    what an average attack would create against the same opponents, and likewise for defence), which is
    the maximum-likelihood solution of the Poisson model above."""
    promoted = promoted or set()
    prior = {t: (PROMOTED_PRIOR if t in promoted else {"att": 0.0, "def": 0.0}) for t in teams}
    rows = []
    for m in matches:
        age = max(0.0, (ref - m["date"]).total_seconds() / 86400.0)
        hx, ax = _damp(float(m["hxg"])), _damp(float(m["axg"]))
        rows.append((m["home"], m["away"], hx, ax, 0.5 ** (age / HALF_LIFE_DAYS)))

    att = {t: prior[t]["att"] for t in teams}
    dfn = {t: prior[t]["def"] for t in teams}
    tot_w = sum(w for *_, w in rows) or 1.0
    mu = math.log(max(1e-6, sum(w * (h + a) for _, _, h, a, w in rows) / (2 * tot_w))) if rows else math.log(1.35)
    home = 0.0
    for _ in range(FIT_ITERATIONS):
        # attack: created / expected-if-average-attack, plus the prior's pseudo-matches
        num = {t: PRIOR_MATCHES * math.exp(mu + prior[t]["att"]) for t in teams}
        den = {t: PRIOR_MATCHES * math.exp(mu) for t in teams}
        for h, a, hx, ax, w in rows:
            if h in att and a in att:
                num[h] += w * hx
                den[h] += w * math.exp(mu + home + dfn[a])
                num[a] += w * ax
                den[a] += w * math.exp(mu + dfn[h])
        att = {t: math.log(num[t] / den[t]) for t in teams}
        # defence: conceded / expected-if-average-defence
        num = {t: PRIOR_MATCHES * math.exp(mu + prior[t]["def"]) for t in teams}
        den = {t: PRIOR_MATCHES * math.exp(mu) for t in teams}
        for h, a, hx, ax, w in rows:
            if h in att and a in att:
                num[a] += w * hx
                den[a] += w * math.exp(mu + home + att[h])
                num[h] += w * ax
                den[h] += w * math.exp(mu + att[a])
        dfn = {t: math.log(num[t] / den[t]) for t in teams}
        # centre att/def on the average team, then refit mu and home advantage
        ca, cd = sum(att.values()) / len(att), sum(dfn.values()) / len(dfn)
        att = {t: v - ca for t, v in att.items()}
        dfn = {t: v - cd for t, v in dfn.items()}
        hs = he = as_ = ae = 0.0
        for h, a, hx, ax, w in rows:
            if h in att and a in att:
                hs += w * hx
                he += w * math.exp(att[h] + dfn[a])
                as_ += w * ax
                ae += w * math.exp(att[a] + dfn[h])
        if he and ae:
            mu = math.log(as_ / ae)
            home = math.log((hs / he) / (as_ / ae))
    return {"mu": mu, "home": home, "att": att, "def": dfn}


def model_goals(s: dict, home_team: str, away_team: str) -> tuple[float, float]:
    """(home expected goals, away expected goals) from fitted strengths."""
    return (math.exp(s["mu"] + s["home"] + s["att"][home_team] + s["def"][away_team]),
            math.exp(s["mu"] + s["att"][away_team] + s["def"][home_team]))


def average_goals_for(s: dict, team: str) -> float:
    """A team's expected goals against an average opponent, half home / half away — the baseline its
    players' per-90 rates were earned at, so a fixture's attack multiplier is lam_for / this."""
    return math.exp(s["mu"] + s["home"] / 2 + s["att"][team])


def average_goals_against(s: dict, team: str) -> float:
    """A team's expected goals conceded to an average opponent, half home / half away."""
    return math.exp(s["mu"] + s["home"] / 2 + s["def"][team])


# --- odds -----------------------------------------------------------------------------------------

def _poisson(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def odds_to_goals(odds_h: float, odds_d: float, odds_a: float, odds_over: float, odds_under: float
                  ) -> tuple[float, float] | None:
    """Market expected goals (home, away) from decimal odds, assuming independent Poisson scores.
    Margins are removed by normalising implied probabilities. Total goals T is solved from
    P(T >= 3) = p_over; the split is then solved so P(home win) - P(away win) matches the 1X2 market."""
    try:
        ih, id_, ia = 1 / odds_h, 1 / odds_d, 1 / odds_a
        io_, iu = 1 / odds_over, 1 / odds_under
    except (TypeError, ZeroDivisionError):
        return None
    if any(math.isnan(x) for x in (ih, id_, ia, io_, iu)):
        return None
    ph, pa = ih / (ih + id_ + ia), ia / (ih + id_ + ia)
    p_over = io_ / (io_ + iu)

    def p_over_of(total: float) -> float:
        return 1 - sum(_poisson(k, total) for k in range(3))

    lo, hi = 0.2, 7.0
    for _ in range(50):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if p_over_of(mid) < p_over else (lo, mid)
    total = (lo + hi) / 2

    def diff_of(sup: float) -> float:
        lh, la = (total + sup) / 2, (total - sup) / 2
        ph_ = pa_ = 0.0
        for i in range(11):
            for j in range(11):
                p = _poisson(i, lh) * _poisson(j, la)
                if i > j:
                    ph_ += p
                elif j > i:
                    pa_ += p
        return ph_ - pa_

    lo, hi = -total + 0.02, total - 0.02
    target = ph - pa
    for _ in range(40):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if diff_of(mid) < target else (lo, mid)
    sup = (lo + hi) / 2
    return (total + sup) / 2, (total - sup) / 2


def _fd_frame(text: str) -> pd.DataFrame:
    return pd.read_csv(io.StringIO(text.lstrip("﻿")))


def fpl_name(fd: str, fpl_names: list[str]) -> str | None:
    fd = FD_ALIASES.get(fd, fd)
    if fd in fpl_names:
        return fd
    return next((n for n in fpl_names if n.startswith(fd + " ")), None)


def odds_rows(df: pd.DataFrame, fpl_names: list[str]) -> dict[tuple[str, str], tuple[float, float]]:
    """{(home FPL name, away FPL name): (lam_h, lam_a)} for Premier League rows with market-average odds.
    Each pairing happens once per season at each ground, so (home, away) identifies the fixture."""
    out = {}
    if "Div" in df:
        df = df[df["Div"] == "E0"]
    for row in df.to_dict("records"):
        lam = odds_to_goals(row.get("AvgH"), row.get("AvgD"), row.get("AvgA"), row.get("Avg>2.5"), row.get("Avg<2.5"))
        h, a = fpl_name(row["HomeTeam"], fpl_names), fpl_name(row["AwayTeam"], fpl_names)
        if lam and h and a:
            out[(h, a)] = lam
    return out


def season_odds(season_code: str) -> pd.DataFrame:
    """A season's results + odds CSV, e.g. season_code '2425' for 2024-25."""
    r = httpx.get(f"{FD_BASE}/mmz4281/{season_code}/E0.csv", headers={"User-Agent": "Mozilla/5.0"},
                  follow_redirects=True, timeout=30)
    r.raise_for_status()
    return _fd_frame(r.text)


def upcoming_odds(fpl_names: list[str]) -> dict[tuple[str, str], tuple[float, float]]:
    """Market expected goals for the upcoming round (football-data.co.uk fixtures.csv, usually published
    a few days before the deadline). Empty if the round isn't up yet or the site is unreachable."""
    try:
        r = httpx.get(FD_UPCOMING, headers={"User-Agent": "Mozilla/5.0"}, follow_redirects=True, timeout=30)
        r.raise_for_status()
        return odds_rows(_fd_frame(r.text), fpl_names)
    except Exception as exc:  # noqa: BLE001 — odds are an enhancement; the model still runs without them
        print(f"  upcoming odds unavailable ({exc}); using the team model alone")
        return {}


def blend(model_lam: tuple[float, float], odds_lam: tuple[float, float] | None) -> tuple[float, float]:
    if not odds_lam:
        return model_lam
    w = ODDS_WEIGHT
    return (w * odds_lam[0] + (1 - w) * model_lam[0], w * odds_lam[1] + (1 - w) * model_lam[1])
