"""Player form (factors 1, 2, 8, 10, 17 of the accuracy plan): how much of his team's attack runs
through a player, how that is trending, and how often he picks up bonus.

Role share (factor 2)
    xg_share = his xG / the xG his team created while he was on the pitch. A striker taking 35% of his
    team's chances keeps ~35% whether the team makes 3.0 xG against a weak side or 0.8 against a strong
    one, so the share is opponent-adjusted by construction (factor 8). In a fixture, his expected goals
    = xg_share x the team's expected goals there (team_model) x minutes on the pitch / 90.
    xa_share is the same for assists (his xA / team xG on pitch).

Recency (factor 1)
    Each past GW is weighted 0.5 ** (GWs ago / FORM_HALF_LIFE); last season's totals count as
    LAST_SEASON_WEIGHT of this season's. FORM_HALF_LIFE = None means no recency weighting.

Shrinkage
    share = (weighted xG + SHARE_K x position-average share) / (weighted team xG on pitch + SHARE_K), so a
    handful of minutes can't produce an extreme share. SHARE_K is in team-xG units (~1.3 per full game).

Home/away (factor 10)
    The same share computed on home and on away games only, each shrunk toward his overall share by
    HOME_K; the multiplier (share_home / share) ** HOME_SPLIT applies at home (away likewise).
    HOME_SPLIT = 0 switches it off.

Bonus (factor 17)
    bonus90 = his (weighted) bonus per 90, shrunk toward the position average by BONUS_K games.

All strengths are tuned on the 2023-24 backtest and confirmed on held-out seasons (see backtest.py).
"""

from __future__ import annotations

FORM_HALF_LIFE: float | None = None  # GWs; None = off. Tuned 2023-24: 4/8/16 raised captain pts but not MAE
LAST_SEASON_WEIGHT = 1.0  # tuned 2023-24 (0.25/0.5/1.0): 1.0 best top-20
SHARE_K = 2.0  # tuned 2023-24 (2/4/8)
HOME_K = 6.0
HOME_SPLIT = 0.0  # off: 0.5/1.0 made no measurable difference in the 2023-24 backtest
BONUS_K = 6.0
# Player blowout guard: in one match, a player's xG above PLAYER_XG_CAP counts at half (one 2-xG game,
# often penalties, otherwise sets his share for weeks). None = off.
PLAYER_XG_CAP: float | None = None  # 0.6-1.0 tested 2026-10-18: top-20 and captain worse in most seasons; off


def cap_xg(x: float) -> float:
    return x if PLAYER_XG_CAP is None or x <= PLAYER_XG_CAP else PLAYER_XG_CAP + 0.5 * (x - PLAYER_XG_CAP)


BPS_K = 6.0          # shrink a player's background BPS/90 toward his position average by 6 games
GOAL_BPS = {"GK": 12, "DEF": 12, "MID": 18, "FWD": 24}
MANAGER_RESET = 0.5  # factor 14: games before a managerial change (and last season) count this much


def background_bps(bps: float, mbps: float, goals: float, assists: float, cs: float, gc: float, pos: str) -> float:
    """BPS left after removing what FPL scores for events the bonus simulation draws itself (minutes,
    goals, assists, clean sheets, goals conceded): passes, tackles, recoveries, saves, etc."""
    ev = mbps + GOAL_BPS.get(pos, 18) * goals + 9 * assists     # mbps: 6 per 60'+ game, 3 per shorter one
    if pos in ("GK", "DEF"):
        ev += 12 * cs - 2 * gc                         # -4 per 2 conceded, on average -2 per goal
    return bps - ev


# Newcomer priors (improvement plan phase 2): a player's starting point from his price instead of the
# position average. "new" = only players with no last-season FPL data; "all" = everyone's prior; "off".
NEWCOMER_PRIOR = "new"  # rules-v8: replay 7,736 vs 7,472 pts (won all 3 seasons); RMSE, rank corr, top-20 better in all 4


def price_priors(prev) -> dict[str, dict[str, tuple[float, float]]]:
    """Per position, linear fits on price (tenths of £m) from last season's players: share of team xG and
    xA while on the pitch, and start rate (starts per club fixture registered). {pos: {key: (a, b)}}."""
    import numpy as np

    g = prev.groupby("code").agg(pos=("pos", "last"), price=("value", "mean"), xg=("expected_goals", "sum"),
                                 xa=("expected_assists", "sum"), on=("team_xg_on", "sum"), starts=("starts", "sum"),
                                 rows=("fixture", "size"), minutes=("minutes", "sum"))
    out: dict[str, dict[str, tuple[float, float]]] = {}
    for pos, t in g.groupby("pos"):
        def wls(x, y, w):
            X = np.column_stack([np.ones(len(x)), x])
            W = np.sqrt(w)
            a, b = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)[0]
            return float(a), float(b)
        sh = t[(t.minutes >= 450) & (t.on > 1)]
        st = t[t.rows >= 10]
        out[pos] = {"xg": wls(sh.price.values, (sh.xg / sh.on).values, sh.on.values),
                    "xa": wls(sh.price.values, (sh.xa / sh.on).values, sh.on.values),
                    "start": wls(st.price.values, (st.starts / st.rows).values, st.rows.values)}
    return out


def priced(fit: tuple[float, float], price: float, lo: float, hi: float) -> float:
    a, b = fit
    return min(hi, max(lo, a + b * price))


def prior_base(base: dict, pri: dict | None, price: float | None, has_last: bool) -> dict:
    """The position base rates, with the attacking shares replaced by the price fit when NEWCOMER_PRIOR
    applies to this player."""
    if not pri or price is None or NEWCOMER_PRIOR == "off" or (NEWCOMER_PRIOR == "new" and has_last):
        return base
    return {**base, "xg_share": priced(pri["xg"], price, 0.0, 0.6), "xa_share": priced(pri["xa"], price, 0.0, 0.6)}


def prior_start(pri: dict | None, price: float | None) -> float | None:
    """Start-rate prior from price for a player with no last-season minutes (None when off)."""
    if not pri or price is None or NEWCOMER_PRIOR == "off":
        return None
    return priced(pri["start"], price, 0.02, 0.95)


def base_rates(profiles: dict[str, dict]) -> dict[str, dict]:
    """Position averages from last-season profiles: xg_share, xa_share, bonus90, yellow90."""
    agg: dict[str, dict] = {}
    for p in profiles.values():
        if not p.get("minutes"):
            continue
        a = agg.setdefault(p["pos"], {"xg": 0.0, "xa": 0.0, "on": 0.0, "bonus": 0.0, "yellow": 0.0, "min": 0.0, "bbps": 0.0})
        a["bbps"] += background_bps(p.get("bps", 0), p.get("mbps", 0), p.get("goals", 0),
                                    p.get("assists", 0), p.get("cs", 0), p.get("gc", 0), p["pos"])
        a["xg"] += p["xg"]
        a["xa"] += p["xa"]
        a["on"] += p["team_xg_on"]
        a["bonus"] += p["bonus"]
        a["yellow"] += p["yellow_cards"]
        a["min"] += p["minutes"]
    out = {}
    for pos, a in agg.items():
        n90 = a["min"] / 90.0
        out[pos] = {"xg_share": a["xg"] / a["on"] if a["on"] else 0.0, "xa_share": a["xa"] / a["on"] if a["on"] else 0.0,
                    "bonus90": a["bonus"] / n90 if n90 else 0.0, "yellow90": a["yellow"] / n90 if n90 else 0.0,
                    "bbps90": a["bbps"] / n90 if n90 else 0.0}
    return out


def _w(age: float, reset_age: int | None = None) -> float:
    w = 1.0 if FORM_HALF_LIFE is None else 0.5 ** (age / FORM_HALF_LIFE)
    return w * MANAGER_RESET if reset_age is not None and age >= reset_age else w


def form_profile(entries: list[dict], last: dict | None, base: dict, reset_age: int | None = None,
                 pos: str = "MID") -> dict:
    """entries: this season's per-GW history (fpl_history.entries_before / model live equivalent);
    last: last-season profile (or None); base: position averages. Returns shares, bonus and card rates,
    home/away multipliers and the evidence behind them (for the "i" pop-up). reset_age: GWs at or older
    than this were under a previous manager, so they (and last season) count MANAGER_RESET as much."""
    lw = (LAST_SEASON_WEIGHT * (MANAGER_RESET if reset_age is not None else 1.0)) if last else 0.0
    last = last or {"xg": 0.0, "xa": 0.0, "team_xg_on": 0.0, "minutes": 0.0, "bonus": 0.0, "yellow_cards": 0.0}

    def pooled(sel=lambda e: True):
        xg = xa = on = mins = bonus = yellow = 0.0
        for e in entries:
            if not sel(e):
                continue
            w = _w(e["age"], reset_age)
            xg += w * e["xg"]
            xa += w * e["xa"]
            on += w * e["team_xg_on"]
            mins += w * e["minutes"]
            bonus += w * e["bonus"]
            yellow += w * e.get("yellow", 0.0)
        return xg, xa, on, mins, bonus, yellow

    xg, xa, on, mins, bonus, yellow = pooled()
    xg += lw * last["xg"]
    xa += lw * last["xa"]
    on += lw * last["team_xg_on"]
    mins += lw * last["minutes"]
    bonus += lw * last["bonus"]
    yellow += lw * last["yellow_cards"]

    xg_share = (xg + SHARE_K * base["xg_share"]) / (on + SHARE_K)
    xa_share = (xa + SHARE_K * base["xa_share"]) / (on + SHARE_K)
    n90 = mins / 90.0
    bonus90 = (bonus + BONUS_K * base["bonus90"]) / (n90 + BONUS_K)
    yellow90 = (yellow + BONUS_K * base["yellow90"]) / (n90 + BONUS_K)

    # Background BPS per 90 (for the bonus simulation), same weighting and shrinkage idea.
    bb = bm = 0.0
    for e in entries:
        w = _w(e["age"], reset_age)
        bb += w * background_bps(e.get("bps", 0), e.get("mbps", 0), e.get("goals", 0), e.get("assists", 0),
                                 e.get("cs", 0), e.get("gc", 0), pos)
        bm += w * e["minutes"]
    if lw and last.get("minutes"):
        bb += lw * background_bps(last.get("bps", 0), last.get("mbps", 0), last.get("goals", 0),
                                  last.get("assists", 0), last.get("cs", 0), last.get("gc", 0), pos)
        bm += lw * last["minutes"]
    bbps90 = (bb + BPS_K * base.get("bbps90", 0.0)) / (bm / 90.0 + BPS_K)

    home_mult = {True: 1.0, False: 1.0}
    if HOME_SPLIT:
        for side in (True, False):
            sxg, _, son, *_ = pooled(lambda e, s=side: e.get("home") is s)
            side_share = (sxg + HOME_K * xg_share) / (son + HOME_K)
            home_mult[side] = (side_share / xg_share) ** HOME_SPLIT if xg_share > 0 else 1.0

    return {"xg_share": xg_share, "xa_share": xa_share, "bonus90": bonus90, "yellow90": yellow90, "bbps90": bbps90,
            "home_mult": home_mult, "team_xg_on": on, "n90": n90}
