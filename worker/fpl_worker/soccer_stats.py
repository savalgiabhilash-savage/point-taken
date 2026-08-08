"""Advanced stats via soccerdata (Understat). Season transition note: at 2026/27 preseason
the latest COMPLETE season is 2025/26, so that's what we pull as the model baseline.

soccerdata season "2025" == the 2025/26 season. Data is cached under ~/soccerdata.
"""

from __future__ import annotations

import logging

import pandas as pd
import soccerdata as sd

LEAGUE = "ENG-Premier League"
BASELINE_SEASON = "2025"  # 2025/26

# soccerdata logs a lot at INFO; quiet it so worker output stays readable.
logging.getLogger("soccerdata").setLevel(logging.WARNING)


def understat_player_season(season: str = BASELINE_SEASON) -> pd.DataFrame:
    """Per-player season aggregates: team, player, player_id, minutes, xg, np_xg, xa,
    xg_chain, xg_buildup, shots, key_passes, goals, assists, ..."""
    us = sd.Understat(leagues=LEAGUE, seasons=season)
    return us.read_player_season_stats().reset_index()
