"""Sync the user's FPL team state from the PUBLIC /entry/ endpoints into user_team_state.

Preseason (before the GW1 deadline) a squad is private, so the public picks endpoint is empty
and this stores just the summary; once a gameweek is played the picks become public and this
captures the full squad automatically. Run on a schedule in-season.

    python -m fpl_worker.sync_team
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

from . import db
from .fpl_client import FplClient

USER_ID = "me"  # single-user for now; becomes a real auth user id in v3


def sync(sb, entry_id: int) -> None:
    with FplClient() as client:
        entry = client._get(f"entry/{entry_id}/")
        history = client._get(f"entry/{entry_id}/history/")
        current_event = entry.get("current_event")
        picks_data = client._get(f"entry/{entry_id}/event/{current_event}/picks/") if current_event else None

    # history["chips"] lists chips already PLAYED this season; store what's still AVAILABLE so the
    # column name matches its meaning. (2026/27 two-set nuance is ignored for now.)
    all_chips = ["wildcard", "freehit", "bboost", "3xc"]
    played = {c["name"] for c in history.get("chips", [])}
    chips = [c for c in all_chips if c not in played]

    if not picks_data:
        # Preseason: the squad is private until the GW1 deadline. Do NOT write an empty-picks row —
        # that would clobber the one-time snapshot loaded from /my-team. Keep the existing state.
        print(f"Synced entry {entry_id} ({entry.get('name')}): preseason, squad not public yet — keeping snapshot.")
        return

    eh = picks_data.get("entry_history", {})
    row = {
        "user_id": USER_ID,
        "fpl_entry_id": entry_id,
        "gw": current_event,
        "bank": eh.get("bank"),
        "team_value": eh.get("value"),
        "free_transfers": eh.get("event_transfers"),
        "chips_available": chips,
        "rank": eh.get("overall_rank"),
        "picks": picks_data.get("picks"),
    }
    sb.table("user_team_state").upsert(row, on_conflict="user_id,gw").execute()
    print(f"Synced entry {entry_id} ({entry.get('name')}): gw={row['gw']}, picks={len(row['picks'])}")


def main() -> None:
    load_dotenv()
    entry_id = int(os.environ["FPL_ENTRY_ID"])
    sync(db.get_client(), entry_id)


if __name__ == "__main__":
    main()
