"""Sync every registered user's FPL team into user_team_state (multi-user, Phase 9.4).

Syncs the shared "me" demo (from FPL_ENTRY_ID) plus each row in `profiles`. In-season the public
/entry/ picks are captured directly; preseason (squad private) it keeps or recovers the latest known
snapshot for that entry so no account is left empty. Runs on the schedule.

    python -m fpl_worker.sync_team
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

from . import db
from .fpl_client import FplClient

ALL_CHIPS = ["wildcard", "freehit", "bboost", "3xc"]
FT_CAP = 5


def free_transfers_next(history: dict) -> int:
    """Free transfers available for the NEXT deadline, rebuilt from the entry history (the public API
    doesn't expose it; entry_history.event_transfers is the number of transfers MADE, not available).

    Rules (2024/25+): the first GW you play is unlimited; after each GW you gain +1, capped at 5.
    Transfers beyond your free ones cost 4 pts each (event_transfers_cost), so free ones used =
    transfers − cost/4. Playing a Wildcard or Free Hit keeps your banked free transfers."""
    chip_gws = {c["event"] for c in history.get("chips", []) if c.get("name") in ("wildcard", "freehit")}
    events = sorted(history.get("current", []), key=lambda e: e["event"])
    if not events:
        return 1
    ft = 1  # after your first gameweek (its transfers were unlimited)
    for e in events[1:]:
        if e["event"] not in chip_gws:
            used_free = e.get("event_transfers", 0) - (e.get("event_transfers_cost", 0) // 4)
            ft = max(0, ft - used_free)
        ft = min(FT_CAP, ft + 1)
    return ft


def _sync_one(sb, client: FplClient, entry_id: int, user_id: str) -> None:
    entry = client._get(f"entry/{entry_id}/")
    history = client._get(f"entry/{entry_id}/history/")
    current_event = entry.get("current_event")
    picks_data = client._get(f"entry/{entry_id}/event/{current_event}/picks/") if current_event else None

    played = {c["name"] for c in history.get("chips", [])}
    chips = [c for c in ALL_CHIPS if c not in played]  # available = all - already played
    label = user_id[:8]

    if not picks_data:
        # Preseason: squad is private on the public API. Keep an existing snapshot, or recover the
        # latest known one for this entry (e.g. the "me" import) so the account isn't left empty.
        have = sb.table("user_team_state").select("gw").eq("user_id", user_id).limit(1).execute().data
        if have:
            print(f"  {label} entry {entry_id}: preseason, not public — kept existing.")
            return
        snap = (
            sb.table("user_team_state").select("*").eq("fpl_entry_id", entry_id)
            .order("gw", desc=True).limit(1).execute().data
        )
        if snap:
            row = dict(snap[0])
            row["user_id"] = user_id
            sb.table("user_team_state").upsert(row, on_conflict="user_id,gw").execute()
            print(f"  {label} entry {entry_id}: recovered snapshot ({len(row.get('picks') or [])} picks).")
        else:
            print(f"  {label} entry {entry_id}: preseason, no snapshot yet.")
        return

    eh = picks_data.get("entry_history", {})
    row = {
        "user_id": user_id,
        "fpl_entry_id": entry_id,
        "gw": current_event,
        "bank": eh.get("bank"),
        "team_value": eh.get("value"),
        "free_transfers": free_transfers_next(history),
        "chips_available": chips,
        "rank": eh.get("overall_rank"),
        "picks": picks_data.get("picks"),
    }
    sb.table("user_team_state").upsert(row, on_conflict="user_id,gw").execute()
    print(f"  {label} entry {entry_id} ({entry.get('name')}): gw={current_event}, picks={len(row['picks'])}")


def sync_all(sb) -> None:
    """Sync the shared "me" demo (FPL_ENTRY_ID) plus every registered user's team."""
    targets: list[tuple[int, str]] = []
    env_entry = os.environ.get("FPL_ENTRY_ID")
    if env_entry:
        targets.append((int(env_entry), "me"))
    for p in sb.table("profiles").select("id, fpl_entry_id").execute().data:
        if p.get("fpl_entry_id"):
            targets.append((p["fpl_entry_id"], p["id"]))

    print(f"Syncing {len(targets)} team(s) ...")
    with FplClient() as client:
        for entry_id, user_id in targets:
            try:
                _sync_one(sb, client, entry_id, user_id)
            except Exception as exc:  # noqa: BLE001 — one user's failure shouldn't stop the rest
                print(f"  {user_id[:8]} entry {entry_id}: sync failed ({exc})")


def main() -> None:
    load_dotenv()
    sync_all(db.get_client())


if __name__ == "__main__":
    main()
