"""Map raw FPL API JSON into rows matching the Supabase schema (0001_init.sql).

Only the three tables needed for the Phase 0-1 "first win" are produced here:
teams, players, fixtures. FPL sends many numeric fields as strings ("form": "3.5"),
so we coerce types explicitly.
"""

from __future__ import annotations

from typing import Any

# element_type id -> position code we store/display (GK/DEF/MID/FWD).
POSITION_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
# FPL's own element_types[].singular_name_short — note goalkeeper is "GKP" (we store "GK").
# Asserted below so a schema change is loud, not silent.
API_POSITION_SHORT = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def _f(v: Any) -> float | None:
    """Coerce to float, tolerating '', None, and numeric strings."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def teams_rows(bootstrap: dict) -> list[dict]:
    rows = []
    for t in bootstrap["teams"]:
        rows.append(
            {
                "fpl_id": t["id"],
                "code": t.get("code"),
                "name": t["name"],
                "short_name": t["short_name"],
                "strength": t.get("strength"),
                "strength_overall_home": t.get("strength_overall_home"),
                "strength_overall_away": t.get("strength_overall_away"),
                "strength_attack_home": t.get("strength_attack_home"),
                "strength_attack_away": t.get("strength_attack_away"),
                "strength_defence_home": t.get("strength_defence_home"),
                "strength_defence_away": t.get("strength_defence_away"),
            }
        )
    return rows


def players_rows(bootstrap: dict) -> list[dict]:
    # Sanity-check the position mapping against the API's element_types.
    api_types = {et["id"]: et["singular_name_short"] for et in bootstrap["element_types"]}
    for et_id, expected in API_POSITION_SHORT.items():
        assert api_types.get(et_id) == expected, (
            f"element_type {et_id} is {api_types.get(et_id)!r} in the API, "
            f"expected {expected!r} — FPL position mapping is stale"
        )

    rows = []
    for e in bootstrap["elements"]:
        rows.append(
            {
                "fpl_id": e["id"],
                "code": e.get("code"),
                "web_name": e["web_name"],
                "first_name": e.get("first_name"),
                "second_name": e.get("second_name"),
                "full_name": f"{e.get('first_name', '')} {e.get('second_name', '')}".strip(),
                "team_id": e["team"],
                "element_type": e["element_type"],
                "position": POSITION_MAP[e["element_type"]],
                "now_cost": e["now_cost"],  # tenths of a million (e.g. 75 = £7.5m)
                "status": e.get("status"),
                "chance_of_playing_this_round": _i(e.get("chance_of_playing_this_round")),
                "chance_of_playing_next_round": _i(e.get("chance_of_playing_next_round")),
                "news": e.get("news") or None,
                "news_added": e.get("news_added"),
                "form": _f(e.get("form")),
                "selected_by_percent": _f(e.get("selected_by_percent")),
                "ict_index": _f(e.get("ict_index")),
                "minutes": _i(e.get("minutes")),
                "total_points": _i(e.get("total_points")),
                "expected_goals": _f(e.get("expected_goals")),
                "expected_assists": _f(e.get("expected_assists")),
                "expected_goal_involvements": _f(e.get("expected_goal_involvements")),
                "expected_goals_conceded": _f(e.get("expected_goals_conceded")),
                "expected_goals_per_90": _f(e.get("expected_goals_per_90")),
                "expected_assists_per_90": _f(e.get("expected_assists_per_90")),
                "expected_goal_involvements_per_90": _f(
                    e.get("expected_goal_involvements_per_90")
                ),
                "is_penalty_taker": e.get("penalties_order") == 1,
                "is_setpiece_taker": (
                    e.get("direct_freekicks_order") == 1
                    or e.get("corners_and_indirect_freekicks_order") == 1
                ),
            }
        )
    return rows


def fixtures_rows(fixtures: list) -> list[dict]:
    rows = []
    for f in fixtures:
        rows.append(
            {
                "fpl_id": f["id"],
                "gw": f.get("event"),  # null for not-yet-scheduled fixtures
                "team_h": f["team_h"],
                "team_a": f["team_a"],
                "team_h_difficulty": f.get("team_h_difficulty"),
                "team_a_difficulty": f.get("team_a_difficulty"),
                "kickoff_time": f.get("kickoff_time"),
                "finished": f.get("finished", False),
            }
        )
    return rows
