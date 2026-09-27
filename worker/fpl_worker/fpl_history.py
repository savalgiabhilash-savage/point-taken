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
           "yellow_cards", "starts", "minutes", "total_points", "xP", "bonus")


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
    return df


def teams(season: str) -> pd.DataFrame:
    return _csv(season, "teams.csv")[["id", "name"]]


def last_season_profiles(prev: pd.DataFrame) -> dict[str, dict]:
    """{code: {pos, xg, xa, minutes, bonus, yellow_cards, team_xg_on}} season totals."""
    agg = prev.groupby("code").agg(
        pos=("pos", "last"), xg=("expected_goals", "sum"), xa=("expected_assists", "sum"),
        minutes=("minutes", "sum"), bonus=("bonus", "sum"), yellow_cards=("yellow_cards", "sum"),
        team_xg_on=("team_xg_on", "sum"))
    return {str(int(c)): r._asdict() for c, r in zip(agg.index, agg.itertuples(index=False))}


def entries_before(rows: pd.DataFrame, latest_round: int) -> dict[int, list[dict]]:
    """This season's per-GW history for each player (by element) from dataset rows:
    {age, games, starts, minutes, xg, xa, bonus, yellow, team_xg_on, home (None in a double)}."""
    g = rows.groupby(["element", "round"]).agg(
        games=("fixture", "size"), starts=("starts", "sum"), minutes=("minutes", "sum"),
        xg=("expected_goals", "sum"), xa=("expected_assists", "sum"), bonus=("bonus", "sum"),
        yellow=("yellow_cards", "sum"), team_xg_on=("team_xg_on", "sum"), home=("was_home", "first")).reset_index()
    out: dict[int, list[dict]] = {}
    for h in g.itertuples(index=False):
        out.setdefault(int(h.element), []).append({
            "age": latest_round - int(h.round), "games": int(h.games), "starts": float(h.starts),
            "minutes": float(h.minutes), "xg": float(h.xg), "xa": float(h.xa), "bonus": float(h.bonus),
            "yellow": float(h.yellow), "team_xg_on": float(h.team_xg_on),
            "home": bool(h.home) if h.games == 1 else None})
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
