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

from . import db, fdr, soccer_stats, team_model
from .fpl_client import FplClient

# rules-v4: news lowers availability (news_adjustment). rules-v3: team goals model + odds (team_model.py). rules-v2: recency-weighted minutes (minutes_profile). Bump on any change to how xPts is computed,
# together with MODEL_VERSION in web/lib/supabase.ts and mobile/src/lib/supabase.ts.
MODEL_VERSION = "rules-v4"

GOAL_PTS = {"GK": 6, "DEF": 6, "MID": 5, "FWD": 4}
CS_PTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
ASSIST_PTS = 3
DEFCON_PTS = 2
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}  # actions per match for the 2 pts; GKs can't earn it
DEFCON_K = 3.0  # shrink a player's DefCon per-90 toward the position average by 3 virtual 90s
PRIOR_K = 12.0  # base-rate shrinkage strength, in 90s (~a third of a season)
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
LAST_SEASON_WEIGHT = 0.5  # a 90 of last season counts half as much as a 90 of this season

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


def _minutes(player: dict) -> tuple[float, float, float, float]:
    """Return (p_start, p_play, exp_minutes, p_60). `player["mprof"]` comes from minutes_profile()."""
    m = player["mprof"]
    avail, _ = availability(player)
    p_start = avail * m["start_rate"]
    p_cameo = (1.0 - p_start) * (m["cameo_rate"] if avail > 0 else 0.0)
    p_play = min(1.0, p_start + p_cameo)
    exp_minutes = p_start * m["start_mins"] + p_cameo * m["cameo_mins"]
    p_60 = p_start * m["p60_start"]
    return p_start, p_play, exp_minutes, p_60


# --- fixture / team helpers --------------------------------------------------

def _poisson_at_least(mean: float, k: int) -> float:
    """P(X >= k) for X ~ Poisson(mean)."""
    term, cdf = math.exp(-mean), 0.0
    for i in range(k):
        cdf += term
        term *= mean / (i + 1)
    return max(0.0, 1.0 - cdf)


def _expected_half_goals(lam: float) -> float:
    """E[floor(GC/2)] for GC ~ Poisson(lam): the GK/DEF deduction is -1 per 2 goals conceded, which is
    less than lam/2 (1 goal conceded costs nothing)."""
    total, term = 0.0, math.exp(-lam)
    for k in range(0, 16):
        if k:
            term *= lam / k
        total += (k // 2) * term
    return total


def defcon_rates(elements: list[dict]) -> dict[int, float]:
    """{fpl_id: DefCon actions per 90}, shrunk toward the position average. From FPL bootstrap, which
    counts CBIT for defenders and CBIRT for midfielders/forwards: the same count the threshold uses."""
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    agg: dict[str, list[float]] = {}
    for e in elements:
        a = agg.setdefault(pos[e["element_type"]], [0.0, 0.0])
        a[0] += e.get("defensive_contribution") or 0
        a[1] += e.get("minutes") or 0
    base = {p: (dc / (m / 90.0) if m else 0.0) for p, (dc, m) in agg.items()}
    out = {}
    for e in elements:
        n90 = (e.get("minutes") or 0) / 90.0
        b = base[pos[e["element_type"]]]
        out[e["id"]] = ((e.get("defensive_contribution") or 0) + DEFCON_K * b) / (n90 + DEFCON_K)
    return out


# --- base-rate blending ------------------------------------------------------

def compute_base_rates(players: list[dict], us_by_id: dict) -> dict[str, dict]:
    """Position base per-90 rates (minutes-weighted) across matched players, used as the
    shrinkage prior so small-sample hot rates regress toward the positional average."""
    from collections import defaultdict

    agg = defaultdict(lambda: {"xg": 0.0, "xa": 0.0, "min": 0.0})
    for p in players:
        us = us_by_id.get(p["understat_id"]) if p["understat_id"] else None
        if us and (us.get("minutes") or 0) > 0:
            a = agg[p["position"]]
            a["xg"] += us["xg"]
            a["xa"] += us["xa"]
            a["min"] += us["minutes"]
    base = {}
    for pos, a in agg.items():
        n90 = a["min"] / 90.0
        base[pos] = {"xg90": a["xg"] / n90 if n90 else 0.0, "xa90": a["xa"] / n90 if n90 else 0.0}
    return base


def player_rates(us: dict | None, pos: str, base: dict[str, dict]) -> dict:
    """Empirical-Bayes shrinkage of a player's per-90 toward the position base rate:
    blended = (observed + K*base) / (n90 + K). Unmatched players (no PL data) stay at 0."""
    b = base.get(pos, {"xg90": 0.0, "xa90": 0.0})
    if us and (us.get("minutes") or 0) > 0:
        n90 = us["minutes"] / 90.0
        return {
            "xg90": (us["xg"] + PRIOR_K * b["xg90"]) / (n90 + PRIOR_K),
            "xa90": (us["xa"] + PRIOR_K * b["xa90"]) / (n90 + PRIOR_K),
            "yellow90": (us.get("yellow_cards", 0) or 0) / n90,
        }
    return {"xg90": 0.0, "xa90": 0.0, "yellow90": 0.1}


def _observed(us: dict | None, p: dict) -> dict | None:
    """The attacking sample fed to player_rates: last season's Understat totals (weighted by
    LAST_SEASON_WEIGHT) pooled with this season's FPL xG/xA/minutes, so current form counts fully and
    grows in weight every week. Players with no Understat match (promoted clubs, arrivals from abroad)
    use this season alone. Cards aren't in the FPL fields, so the yellow-card RATE comes from last
    season (0 if unmatched). Returns None when there's no data at all (player_rates then gives 0)."""
    cur_xg, cur_xa, cur_min = p["expected_goals"] or 0.0, p["expected_assists"] or 0.0, p["minutes"] or 0
    last_min = (us.get("minutes") or 0) if us else 0
    if last_min <= 0 and cur_min <= 0:
        return None
    w = LAST_SEASON_WEIGHT
    minutes = w * last_min + cur_min
    yellow_rate = (us.get("yellow_cards", 0) or 0) / last_min if last_min > 0 else 0.0
    return {
        "xg": w * (us["xg"] if last_min > 0 else 0.0) + cur_xg,
        "xa": w * (us["xa"] if last_min > 0 else 0.0) + cur_xa,
        "minutes": minutes,
        "yellow_cards": yellow_rate * minutes,
    }


# --- core projection ---------------------------------------------------------

def project_fixture(player: dict, rates: dict, lam_for: float, lam_against: float, base_for: float,
                    form_mult: float = 1.0) -> dict:
    """One player, one fixture -> component dict of expected points.

    `rates` holds the base-rate-blended per-90 attacking rates (see player_rates). `form_mult` is a
    small preseason-form multiplier on attacking output (2026 World Cup — see form.py); 1.0 = no
    change. It scales the attacking rates only, so it flows through goals, assists, and bonus.

    `lam_for` / `lam_against` are this fixture's expected goals for and against the player's team
    (team_model). `base_for` is the team's expected goals against an average opponent — the level the
    player's per-90 rates were earned at — so attacking output scales by lam_for / base_for."""
    pos = player["position"] or "MID"
    p_start, p_play, exp_min, p_60 = _minutes(player)
    mins_frac = exp_min / 90.0
    adj = lam_for / base_for if base_for else 1.0

    xg90 = rates["xg90"] * form_mult
    xa90 = rates["xa90"] * form_mult
    yellow90 = rates["yellow90"]

    x_goals = xg90 * mins_frac * adj
    x_assists = xa90 * mins_frac * adj
    x_goals_pts = x_goals * GOAL_PTS[pos]
    x_assist_pts = x_assists * ASSIST_PTS

    # clean sheet, saves and goals-conceded deductions all use the fixture's expected goals against
    lam = lam_against
    p_cs = math.exp(-lam)
    x_cs_pts = p_cs * CS_PTS[pos] * p_60

    # appearance
    x_appearance_pts = p_play * 1.0 + p_60 * 1.0

    # saves (GK, rough)
    x_saves_pts = (lam * 2.0 / 3.0) * p_start if pos == "GK" else 0.0

    # defensive contributions: P(reaching the threshold in a start) from the player's per-90 rate
    thr = DEFCON_THRESHOLD.get(pos)
    p_dc = _poisson_at_least(rates.get("dc90", 0.0) * 82 / 90, thr) if thr else 0.0
    x_defcon_pts = DEFCON_PTS * p_dc * p_start

    # bonus proxy from involvement
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
        "p_60": p_60,
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


def recent_minutes_history(live: dict[int, list[dict]], fixtures: list[dict],
                           team_by_player: dict[int, int]) -> dict[int, list[dict]]:
    """{player_id: [{age, games, starts, minutes}, ...]} over the last MINUTES_WINDOW finished GWs. Only
    GWs where the player's CURRENT club played count, so a blank for his club isn't mistaken for being
    dropped."""
    games = _club_games(fixtures)
    finished = sorted(live)[-MINUTES_WINDOW:]
    out: dict[int, list[dict]] = {}
    for gw in finished:
        for e in live[gw]:
            n = games.get((team_by_player.get(e["id"]), gw), 0)
            if n:
                st = e["stats"]
                out.setdefault(e["id"], []).append({"age": finished[-1] - gw, "games": n,
                                                    "starts": st.get("starts") or 0, "minutes": st.get("minutes") or 0})
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
        .select("fpl_id, web_name, understat_id, position, team_id, status, "
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

    us_df = soccer_stats.understat_player_season()
    us_by_id = {str(r["player_id"]): r for r in us_df.to_dict("records")}
    base = compute_base_rates(players, us_by_id)
    if dry_run:
        print("Position base per-90 (shrinkage prior):")
        for pos in ("GK", "DEF", "MID", "FWD"):
            b = base.get(pos, {})
            print(f"  {pos}: xg90={b.get('xg90', 0):.3f} xa90={b.get('xa90', 0):.3f}")
    team_by_player = {p["fpl_id"]: p["team_id"] for p in players}
    name_by_id = {t["fpl_id"]: t["name"] for t in teams}
    with FplClient() as client:
        boot = client.bootstrap_static()
        live = fetch_live(client, fixtures)
    history = recent_minutes_history(live, fixtures, team_by_player)
    dc90 = defcon_rates(boot["elements"])

    # Team goals model: fit strengths on last season's Understat match xG + this season's FPL xG,
    # then blend each upcoming fixture with bookmaker odds where they're published.
    last_matches = fdr.understat_matches()
    matches = last_matches + season_team_matches(live, fixtures, team_by_player, name_by_id)
    names = [t["name"] for t in teams]
    promoted = set(names) - {m["home"] for m in last_matches}
    all_teams = sorted(set(names) | {m["home"] for m in matches} | {m["away"] for m in matches})
    strengths = team_model.fit(matches, datetime.now(timezone.utc), all_teams, promoted)
    odds = team_model.upcoming_odds(names)
    base_for = {t["fpl_id"]: team_model.average_goals_for(strengths, t["name"]) for t in teams}
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
        by_team_gw.setdefault((f["team_h"], f["gw"]), []).append((True, lam_h, lam_a, f["team_a"], mkt is not None))
        by_team_gw.setdefault((f["team_a"], f["gw"]), []).append((False, lam_a, lam_h, f["team_h"], mkt is not None))

    global NEWS_WEIGHT
    NEWS_WEIGHT = _load_params(sb).get("news_weight", NEWS_WEIGHT)
    news = _load_news(sb)
    now = datetime.now(timezone.utc)

    rows = []
    for p in players:
        us = us_by_id.get(p["understat_id"]) if p["understat_id"] else None
        rates = player_rates(_observed(us, p), p["position"], base)
        rates["dc90"] = dc90.get(p["fpl_id"], 0.0)
        hist = history.get(p["fpl_id"], [])
        p["mprof"] = minutes_profile(hist, us.get("minutes") if us else None)
        p["news_adj"] = news_adjustment(news.get(p["fpl_id"]), now)
        avail, fpl_avail = availability(p)
        recent = [h for h in hist if h["age"] < 5]
        # Explanation inputs stored on every projection (the web's "i" pop-up turns these into bullets).
        why = {
            "start_rate": round(p["mprof"]["start_rate"], 3), "p60_start": round(p["mprof"]["p60_start"], 3),
            "recent_starts": sum(h["starts"] for h in recent), "recent_games": sum(h["games"] for h in recent),
            "recent_minutes": sum(h["minutes"] for h in recent),
            "fpl_avail": round(fpl_avail, 2), "news_adj": round(p["news_adj"], 3), "avail": round(avail, 3),
            "xg90": round(rates["xg90"], 3), "xa90": round(rates["xa90"], 3), "dc90": round(rates["dc90"], 2),
            "season": {"xg": round(p["expected_goals"] or 0, 2), "xa": round(p["expected_assists"] or 0, 2),
                       "min": p["minutes"] or 0},
            "last": ({"xg": round(us["xg"], 2), "xa": round(us["xa"], 2), "min": int(us["minutes"])} if us else None),
        }
        # World Cup form is a preseason stand-in; once the club has played, real minutes/xG take over.
        fm = form.get(p["fpl_id"], 1.0) if team_games.get(p["team_id"], 0) == 0 else 1.0
        for gw in gws:
            fxs = by_team_gw.get((p["team_id"], gw), [])
            if not fxs:
                continue  # blank GW for this team
            agg: dict[str, float] = {}
            opp_short = []
            xg_for, xg_against, with_odds, atk_mult, p_cs = [], [], [], [], []
            for is_home, lam_for, lam_against, opp_id, has_odds in fxs:
                comp = project_fixture(p, rates, lam_for, lam_against, base_for[p["team_id"]], form_mult=fm)
                xg_for.append(round(lam_for, 2))
                xg_against.append(round(lam_against, 2))
                with_odds.append(has_odds)
                atk_mult.append(round(comp["fixture_adj"], 3))
                p_cs.append(round(comp["p_cs"], 3))
                fx_why = {"p_start": round(comp["p_start"], 3), "p_60": round(comp["p_60"], 3),
                          "exp_minutes": round(comp["exp_minutes"], 1), "p_dc": round(comp["p_dc"], 3)}
                for k, v in comp.items():
                    if k in ("p_start", "p_60", "p_dc", "exp_minutes", "fixture_adj", "p_cs", "xg90", "xa90"):
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
                               "atk_mult": atk_mult, "p_cs": p_cs, **fx_why, "why": why},
                "_web_name": p["web_name"],
                "_pos": p["position"],
                "_cost": p["now_cost"],
                "_opp": ",".join(opp_short),
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
