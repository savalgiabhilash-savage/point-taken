"""Past-season FPL data (the public vaastav/Fantasy-Premier-League dataset), shared by the live model and
the backtest so both read "last season" identically.

Every row is one player in one fixture, with FPL's own (Opta) xG/xA, minutes, starts, bonus, cards and
the stable cross-season player `code` (FPL ids change every season; `code` doesn't). From it we derive:
  * team_xg_on: the xG his team created while he was on the pitch (team xG in that fixture x his
    minutes / 90) — the denominator of his role share (form_model.py);
  * last-season profiles per player (by code) and position base rates — the priors for this season;
  * last season's matches (xG per side) for the team goals model.
Files are downloaded once and cached under .cache/vaastav.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd

BASE_URL = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
CACHE = Path(".cache") / "vaastav"
POSITIONS = {"GK": "GK", "GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}  # drops "AM" rows
NUMERIC = ("expected_goals", "expected_assists", "expected_goals_conceded", "defensive_contribution",
           "yellow_cards", "starts", "minutes", "total_points", "xP", "bonus", "bps", "goals_scored", "assists",
           "clean_sheets", "goals_conceded")


def _csv(season: str, path: str) -> pd.DataFrame:
    """Download a dataset file once, then read it from the local cache."""
    local = CACHE / season / path.replace("/", "_")
    if not local.exists():
        local.parent.mkdir(parents=True, exist_ok=True)
        pd.read_csv(f"{BASE_URL}/{season}/{path}").to_csv(local, index=False)
    return pd.read_csv(local)


def prev_season(season: str) -> str:
    a, b = season.split("-")
    return f"{int(a) - 1}-{int(b) - 1:02d}"


def season_of(year_started: int) -> str:
    """2026 -> '2026-27'."""
    return f"{year_started}-{(year_started + 1) % 100:02d}"


def load_season(season: str) -> pd.DataFrame:
    """Per-player, per-fixture rows with `code`, a clean position, and team_xg_on."""
    gw = _csv(season, "gws/merged_gw.csv")
    raw = _csv(season, "players_raw.csv")[["id", "code"]].rename(columns={"id": "element"})
    df = gw.merge(raw, on="element", how="left")
    df["pos"] = df["position"].map(POSITIONS)
    df = df[df["pos"].notna()].copy()
    for col in NUMERIC:
        if col not in df:
            df[col] = 0.0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    df["was_home"] = df["was_home"].astype(str).str.lower().eq("true")
    # The team's xG in each fixture, and the part of it created while this player was on the pitch.
    df["team_fx_xg"] = df.groupby(["fixture", "team"])["expected_goals"].transform("sum")
    df["team_xg_on"] = df["team_fx_xg"] * df["minutes"] / 90.0
    # BPS for minutes alone (6 for 60'+, 3 for less): removed to get his background BPS (bonus_sim).
    df["mbps"] = (df["minutes"] >= 60) * 3.0 + (df["minutes"] > 0) * 3.0
    return df


def teams(season: str) -> pd.DataFrame:
    return _csv(season, "teams.csv")[["id", "name"]]


def last_season_profiles(prev: pd.DataFrame) -> dict[str, dict]:
    """{code: {pos, xg, xa, minutes, bonus, yellow_cards, team_xg_on}} season totals."""
    from .form_model import cap_xg
    prev = prev.assign(xg_c=prev["expected_goals"].map(cap_xg))
    agg = prev.groupby("code").agg(
        pos=("pos", "last"), xg=("xg_c", "sum"), xa=("expected_assists", "sum"),
        minutes=("minutes", "sum"), bonus=("bonus", "sum"), yellow_cards=("yellow_cards", "sum"),
        team_xg_on=("team_xg_on", "sum"), bps=("bps", "sum"), goals=("goals_scored", "sum"),
        assists=("assists", "sum"), cs=("clean_sheets", "sum"), gc=("goals_conceded", "sum"),
        mbps=("mbps", "sum"), dc=("defensive_contribution", "sum"), pts=("total_points", "sum"),
        rows=("fixture", "size"))
    return {str(int(c)): r._asdict() for c, r in zip(agg.index, agg.itertuples(index=False))}


def entries_before(rows: pd.DataFrame, latest_round: int) -> dict[int, list[dict]]:
    """This season's per-GW history for each player (by element) from dataset rows:
    {age, games, starts, minutes, xg, xa, bonus, yellow, team_xg_on, home (None in a double)}."""
    from .form_model import cap_xg
    rows = rows.assign(xg_c=rows["expected_goals"].map(cap_xg))
    g = rows.groupby(["element", "round"]).agg(
        games=("fixture", "size"), starts=("starts", "sum"), minutes=("minutes", "sum"),
        xg=("xg_c", "sum"), xa=("expected_assists", "sum"), bonus=("bonus", "sum"),
        yellow=("yellow_cards", "sum"), team_xg_on=("team_xg_on", "sum"), home=("was_home", "first"),
        bps=("bps", "sum"), goals=("goals_scored", "sum"), assists=("assists", "sum"), cs=("clean_sheets", "sum"),
        gc=("goals_conceded", "sum"), mbps=("mbps", "sum"), pts=("total_points", "sum")).reset_index()
    out: dict[int, list[dict]] = {}
    for h in g.itertuples(index=False):
        out.setdefault(int(h.element), []).append({
            "age": latest_round - int(h.round), "games": int(h.games), "starts": float(h.starts),
            "minutes": float(h.minutes), "xg": float(h.xg), "xa": float(h.xa), "bonus": float(h.bonus),
            "yellow": float(h.yellow), "team_xg_on": float(h.team_xg_on),
            "home": bool(h.home) if h.games == 1 else None,
            "bps": float(h.bps), "goals": float(h.goals), "assists": float(h.assists), "cs": float(h.cs),
            "gc": float(h.gc), "mbps": float(h.mbps), "pts": float(h.pts)})
    return out


def season_matches(df: pd.DataFrame) -> list[dict]:
    """Each match's xG per side (sum of that side's players' expected_goals), kickoff date and round,
    for the team goals model."""
    side = df.groupby(["fixture", "was_home"]).agg(
        team=("team", "first"), xg=("expected_goals", "sum"),
        kickoff=("kickoff_time", "first"), round=("round", "first")).reset_index()
    home = side[side["was_home"]].set_index("fixture")
    away = side[~side["was_home"]].set_index("fixture")
    out = []
    for f in home.index.intersection(away.index):
        h, a = home.loc[f], away.loc[f]
        out.append({"home": h["team"], "away": a["team"], "hxg": h["xg"], "axg": a["xg"], "round": int(h["round"]),
                    "date": datetime.fromisoformat(str(h["kickoff"]).replace("Z", "+00:00"))})
    return out


def build_current_season(season: str) -> None:
    """Rebuild the dataset files for the season in progress from the FPL API (bootstrap, fixtures,
    event/{gw}/live), in the same shape as the vaastav files, so the backtest can replay this season too.
    The vaastav repo lags (often only GW1 early on). xP is left empty (no leak-free benchmark).
    A double gameweek's stats are split evenly across its two fixtures (event/live only has GW totals)."""
    import httpx

    base = "https://fantasy.premierleague.com/api/"
    with httpx.Client(timeout=30, headers={"User-Agent": "Mozilla/5.0"}) as c:
        bs = c.get(base + "bootstrap-static/").json()
        fixtures = c.get(base + "fixtures/").json()
        finished = [e["id"] for e in bs["events"] if e["finished"]]
        live = {g: c.get(base + f"event/{g}/live/").json()["elements"] for g in finished}
    team_name = {t["id"]: t["name"] for t in bs["teams"]}
    pos = {t["id"]: t["singular_name_short"] for t in bs["element_types"]}
    els = {e["id"]: e for e in bs["elements"]}
    by_team_gw: dict[tuple[int, int], list[dict]] = {}
    for f in fixtures:
        if f["event"] in live and f["finished"]:
            by_team_gw.setdefault((f["team_h"], f["event"]), []).append(f)
            by_team_gw.setdefault((f["team_a"], f["event"]), []).append(f)
    stat_cols = ("total_points", "minutes", "starts", "goals_scored", "assists", "clean_sheets", "goals_conceded",
                 "own_goals", "penalties_saved", "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus",
                 "bps", "expected_goals", "expected_assists", "expected_goals_conceded", "defensive_contribution")
    rows = []
    for g, elements in live.items():
        for p in elements:
            e = els.get(p["id"])
            if e is None:
                continue
            fxs = by_team_gw.get((e["team"], g), [])
            for f in fxs:
                home = f["team_h"] == e["team"]
                row = {"name": e["web_name"], "position": pos[e["element_type"]], "team": team_name[e["team"]],
                       "element": p["id"], "fixture": f["id"], "round": g, "GW": g, "kickoff_time": f["kickoff_time"],
                       "opponent_team": f["team_a"] if home else f["team_h"], "was_home": home, "xP": None}
                for k in stat_cols:
                    row[k] = float(p["stats"].get(k) or 0) / len(fxs)
                rows.append(row)
    out = CACHE / season
    out.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out / "gws_merged_gw.csv", index=False)
    pd.DataFrame([{"id": e["id"], "code": e["code"]} for e in bs["elements"]]).to_csv(out / "players_raw.csv", index=False)
    pd.DataFrame([{"id": t["id"], "name": t["name"]} for t in bs["teams"]]).to_csv(out / "teams.csv", index=False)
    print(f"Rebuilt {season} from the FPL API: GW{min(finished)}-{max(finished)}, {len(rows)} player-fixture rows")
