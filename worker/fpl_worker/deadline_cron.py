"""Cron lines for the pre-deadline refresh (.github/workflows/deadline.yml), one per remaining gameweek.

GitHub's schedule can't follow FPL deadlines by itself, and checking every half hour would use too many
Actions minutes on a private repo. FPL publishes every deadline in advance, so this prints one cron per
deadline, LEAD_MIN minutes before it (GitHub often starts scheduled runs 10-30 min late). The workflow
re-checks the deadline before doing anything, so a moved deadline just makes that run exit.

    python -m fpl_worker.deadline_cron      # then paste the lines into deadline.yml's schedule
Re-run it when FPL reschedules gameweeks (cup clashes usually move some in the second half).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

import httpx

LEAD_MIN = 100   # cron fires this long before the deadline
WINDOW = (45, 150)  # the run goes ahead only if the deadline is this many minutes away


def deadlines() -> list[tuple[int, datetime]]:
    boot = httpx.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30,
                     headers={"User-Agent": "Mozilla/5.0"}).json()
    now = datetime.now(timezone.utc)
    out = []
    for e in boot["events"]:
        d = datetime.fromisoformat(e["deadline_time"].replace("Z", "+00:00"))
        if d > now:
            out.append((e["id"], d))
    return out


def check() -> int:
    """Exit code 0 if the next deadline is inside WINDOW minutes, else 1 (the workflow then stops)."""
    nxt = deadlines()
    if not nxt:
        return 1
    gw, d = nxt[0]
    mins = (d - datetime.now(timezone.utc)).total_seconds() / 60
    print(f"GW{gw} deadline in {mins:.0f} min")
    return 0 if WINDOW[0] <= mins <= WINDOW[1] else 1


def main() -> None:
    if "--check" in sys.argv:
        sys.exit(check())
    for gw, d in deadlines():
        t = d - timedelta(minutes=LEAD_MIN)
        print(f'    - cron: "{t.minute} {t.hour} {t.day} {t.month} *"  # GW{gw}, deadline {d:%a %d %b %H:%M} UTC')


if __name__ == "__main__":
    main()
