"""Rules-based expected-points (xPts) model — Phase 3, spec §3.1.

Transparent by design: every projection is the sum of named components, each stored so the UI
can explain the headline number. Attacking output pools last-season Understat xG (via the crosswalk,
half weight) with this season's FPL xG; minutes blend this season's minutes share with last season's;
defensive contributions use each player's FPL per-90 rate; team strength pools last season's
Understat team xG with this season's FPL team xG.

    python -m fpl_worker.model --dry-run            # compute + print top projections, no DB write
    python -m fpl_worker.model --run --horizon 5    # write projections for the next 5 GWs
"""

from __future__ import annotations

import argparse
import math

from dotenv import load_dotenv

from . import db, fdr, soccer_stats
from .fpl_client import FplClient

MODEL_VERSION = "rules-v1"

GOAL_PTS = {"GK": 6, "DEF": 6, "MID": 5, "FWD": 4}
CS_PTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
ASSIST_PTS = 3
DEFCON_PTS = 2
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}  # actions per match for the 2 pts; GKs can't earn it
DEFCON_K = 3.0  # shrink a player's DefCon per-90 toward the position average by 3 virtual 90s
HOME_ATTACK = {True: 1.05, False: 0.95}  # home sides create a little more
PRIOR_K = 12.0  # base-rate shrinkage strength, in 90s (~a third of a season)
LAST_GW = 38
MINUTES_K = 4.0  # games of this season before its minutes share outweighs last season's prior
LAST_SEASON_WEIGHT = 0.5  # a 90 of last season counts half as much as a 90 of this season

# --- minutes -----------------------------------------------------------------

def _availability(status: str | None, chance: int | None) -> float:
    if status in ("i", "s", "u", "n"):
        return 0.0
    if chance is not None:
        return chance / 100.0
    return 0.5 if status == "d" else 1.0  # 'd' doubtful, else available


def nailedness(cur_minutes: int | None, team_games: int, last_minutes: float | None) -> float:
    """How nailed-on a player is (0..1): a blend of this season's minutes share and last season's.

    `cur_minutes` is FPL's players.minutes — THIS season's total, so it must be divided by the games
    the club has actually played (not a full season). `last_minutes` is last season's Understat
    minutes (None if the player isn't matched). This season's share gets weight
    team_games / (team_games + MINUTES_K), so after 4 games it counts as much as last season, and
    by mid-season it dominates. Unmatched players (promoted clubs, arrivals from abroad) have no
    prior, so they rely on this season alone."""
    prior = min(1.0, last_minutes / 2600) if last_minutes else None  # ~29 full games = nailed
    if team_games <= 0:
        return prior or 0.0
    current = min(1.0, (cur_minutes or 0) / (90.0 * team_games))
    if prior is None:
        return current
    w = team_games / (team_games + MINUTES_K)
    return w * current + (1.0 - w) * prior


def _minutes(player: dict) -> tuple[float, float, float]:
    """Return (p_start, p_play, exp_minutes). `player["nailed"]` comes from nailedness()."""
    avail = _availability(player["status"], player["chance_of_playing_next_round"])
    p_start = avail * player["nailed"]
    p_cameo = (1.0 - p_start) * (0.15 if avail > 0 else 0.0)
    p_play = min(1.0, p_start + p_cameo)
    exp_minutes = p_start * 82 + p_cameo * 20
    return p_start, p_play, exp_minutes


# --- fixture / team helpers --------------------------------------------------

def _attack_adj(opp: dict, league_xga: float, is_home: bool) -> float:
    """Attacking multiplier from the OPPONENT'S DEFENCE: their xG conceded per game relative to the
    league average (a leaky side at 1.6 vs 1.35 avg -> x1.19), times a small home/away tweak."""
    return (opp["xga_pg"] / league_xga if league_xga else 1.0) * HOME_ATTACK[is_home]


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


def build_team_ratings_by_id(teams: list[dict], ratings_by_name: dict[str, dict]) -> dict[int, dict]:
    """{fpl_id: {xgf_pg, xga_pg}} with a weak fallback for promoted clubs (no last-season data)."""
    known = [r for r in ratings_by_name.values()]
    if known:
        weak_att = min(r["xgf_pg"] for r in known)
        leaky_def = max(r["xga_pg"] for r in known)
    else:
        weak_att, leaky_def = 1.0, 1.6
    out: dict[int, dict] = {}
    for t in teams:
        r = ratings_by_name.get(t["name"])
        out[t["fpl_id"]] = r if r else {"xgf_pg": weak_att, "xga_pg": leaky_def, "rating": None}
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

def project_fixture(player: dict, rates: dict, is_home: bool, league_xga: float,
                    our: dict, opp: dict, form_mult: float = 1.0) -> dict:
    """One player, one fixture -> component dict of expected points.

    `rates` holds the base-rate-blended per-90 attacking rates (see player_rates). `form_mult` is a
    small preseason-form multiplier on attacking output (2026 World Cup — see form.py); 1.0 = no
    change. It scales the attacking rates only, so it flows through goals, assists, and bonus."""
    pos = player["position"] or "MID"
    p_start, p_play, exp_min = _minutes(player)
    mins_frac = exp_min / 90.0
    adj = _attack_adj(opp, league_xga, is_home)

    xg90 = rates["xg90"] * form_mult
    xa90 = rates["xa90"] * form_mult
    yellow90 = rates["yellow90"]

    x_goals = xg90 * mins_frac * adj
    x_assists = xa90 * mins_frac * adj
    x_goals_pts = x_goals * GOAL_PTS[pos]
    x_assist_pts = x_assists * ASSIST_PTS

    # clean sheet: expected goals conceded blends opponent attack and our defence, home tweak
    lam = 0.5 * opp["xgf_pg"] + 0.5 * our["xga_pg"]
    lam *= 0.9 if is_home else 1.1
    p_cs = math.exp(-lam)
    p_60 = p_start * 0.9
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


def _load_form(sb) -> dict[int, float]:
    """Preseason (World Cup) form multipliers by fpl_id (form.py). Empty (=> no change) if the table
    isn't there yet. A small, bounded nudge to attacking output until the domestic season starts."""
    try:
        rows = sb.table("preseason_form").select("player_id, form_mult").execute().data
        return {r["player_id"]: float(r["form_mult"]) for r in rows}
    except Exception:  # noqa: BLE001 — table may not exist yet; projections must still run
        return {}


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
        .select("gw, team_h, team_a, custom_fdr_h, custom_fdr_a, finished")
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
    with FplClient() as client:
        boot = client.bootstrap_static()
    dc90 = defcon_rates(boot["elements"])
    ratings = fdr.blend_with_current(fdr.team_ratings(), teams, players, fixtures)
    team_rt = build_team_ratings_by_id(teams, ratings)
    league_xga = sum(r["xga_pg"] for r in team_rt.values()) / len(team_rt)
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

    # index fixtures by (team_id, gw) -> list of (is_home, fdr, opp_team_id). The custom FDR is only for
    # display (Fixtures page); the model uses the opponent's xG conceded (see _attack_adj).
    by_team_gw: dict[tuple[int, int], list] = {}
    for f in upcoming:
        if f["gw"] not in gws:
            continue
        by_team_gw.setdefault((f["team_h"], f["gw"]), []).append((True, f["custom_fdr_h"], f["team_a"]))
        by_team_gw.setdefault((f["team_a"], f["gw"]), []).append((False, f["custom_fdr_a"], f["team_h"]))

    rows = []
    for p in players:
        us = us_by_id.get(p["understat_id"]) if p["understat_id"] else None
        rates = player_rates(_observed(us, p), p["position"], base)
        rates["dc90"] = dc90.get(p["fpl_id"], 0.0)
        p["nailed"] = nailedness(p["minutes"], team_games.get(p["team_id"], 0), us.get("minutes") if us else None)
        our = team_rt.get(p["team_id"], {"xgf_pg": 1.3, "xga_pg": 1.4})
        # World Cup form is a preseason stand-in; once the club has played, real minutes/xG take over.
        fm = form.get(p["fpl_id"], 1.0) if team_games.get(p["team_id"], 0) == 0 else 1.0
        for gw in gws:
            fxs = by_team_gw.get((p["team_id"], gw), [])
            if not fxs:
                continue  # blank GW for this team
            agg: dict[str, float] = {}
            opp_short = []
            for is_home, _fdr, opp_id in fxs:
                comp = project_fixture(p, rates, is_home, league_xga, our, team_rt.get(opp_id, our), form_mult=fm)
                for k, v in comp.items():
                    if k in ("p_start", "exp_minutes", "fixture_adj", "p_cs", "xg90", "xa90"):
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
                "components": {"opponents": opp_short, "n_fixtures": len(fxs), "form": round(fm, 3)},
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
