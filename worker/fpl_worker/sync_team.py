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
# Since 2025/26 every chip comes twice: one set for GW1-19 (lost if unused by the GW19 deadline) and a
# fresh set for GW20-38.
CHIP_HALF_END = 19


def chips_available_for(history: dict, gw: int) -> list[str]:
    """Chips still playable in the half-season containing `gw` (a chip played in the other half
    doesn't count against this half's copy)."""
    lo, hi = (1, CHIP_HALF_END) if gw <= CHIP_HALF_END else (CHIP_HALF_END + 1, 38)
    played = {c["name"] for c in history.get("chips", []) if lo <= c["event"] <= hi}
    return [c for c in ALL_CHIPS if c not in played]


def selling_prices(client: FplClient, entry_id: int, element_ids: list[int]) -> dict[int, int]:
    """FPL selling price (tenths of £m) for each owned player: purchase price + half of any rise,
    rounded down; a fall is taken in full. Purchase price = the latest permanent transfer-in (Free Hit
    weeks revert, so they're ignored); players kept from the entry's first squad were bought at their
    price in its first gameweek."""
    history = client._get(f"entry/{entry_id}/history/")
    transfers = client._get(f"entry/{entry_id}/transfers/")
    boot = client.bootstrap_static()
    now = {e["id"]: e["now_cost"] for e in boot["elements"]}
    start = {e["id"]: e["now_cost"] - (e.get("cost_change_start") or 0) for e in boot["elements"]}
    fh_gws = {c["event"] for c in history.get("chips", []) if c["name"] == "freehit"}
    first_gw = min((e["event"] for e in history.get("current", [])), default=1)

    bought: dict[int, tuple[int, int]] = {}  # element -> (event, price) of its latest transfer-in
    for t in transfers:
        if t["event"] in fh_gws:
            continue
        el, ev = t["element_in"], t["event"]
        if el not in bought or ev >= bought[el][0]:
            bought[el] = (ev, t["element_in_cost"])

    out: dict[int, int] = {}
    for el in element_ids:
        if el not in now:
            continue
        if el in bought:
            purchase = bought[el][1]
        elif first_gw <= 1:
            purchase = start[el]
        else:  # joined mid-season: price in the entry's first gameweek
            hist = client.element_summary(el).get("history", [])
            purchase = next((h["value"] for h in hist if h["round"] >= first_gw), start[el])
        cur = now[el]
        out[el] = cur if cur <= purchase else purchase + (cur - purchase) // 2
    return out


def free_transfers_next(history: dict) -> int:
    """Free transfers available for the NEXT deadline, rebuilt from the entry history (the public API
    doesn't expose it; entry_history.event_transfers is the number of transfers MADE, not available).

    Rules (2024/25+): the first GW you play is unlimited; after each GW you gain +1, capped at 5.
    Transfers beyond your free ones cost 4 pts each (event_transfers_cost), so free ones used =
    transfers − cost/4. Playing a Wildcard or Free Hit keeps your banked free transfers exactly as they
    were: that gameweek neither uses them nor adds the usual +1."""
    chip_gws = {c["event"] for c in history.get("chips", []) if c.get("name") in ("wildcard", "freehit")}
    events = sorted(history.get("current", []), key=lambda e: e["event"])
    if not events:
        return 1
    ft = 1  # after your first gameweek (its transfers were unlimited)
    for e in events[1:]:
        if e["event"] in chip_gws:
            continue  # frozen: no transfers used, no +1
        used_free = e.get("event_transfers", 0) - (e.get("event_transfers_cost", 0) // 4)
        ft = min(FT_CAP, max(0, ft - used_free) + 1)
    return ft


def _sync_one(sb, client: FplClient, entry_id: int, user_id: str) -> None:
    entry = client._get(f"entry/{entry_id}/")
    history = client._get(f"entry/{entry_id}/history/")
    current_event = entry.get("current_event")
    picks_data = client._get(f"entry/{entry_id}/event/{current_event}/picks/") if current_event else None

    chips = chips_available_for(history, (current_event or 0) + 1)  # half of the next deadline
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
