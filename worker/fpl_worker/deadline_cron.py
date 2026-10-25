"""Deadline check for the pre-deadline refresh (.github/workflows/deadline.yml).

Supabase starts that workflow about 100 minutes before each deadline (migration 0011). As a guard against a
stray or late start, the workflow first runs this check and only continues if the next deadline is WINDOW
minutes away.

    python -m fpl_worker.deadline_cron --check     # exit 0 if a deadline is near, else 1
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import httpx

WINDOW = (45, 180)  # the run goes ahead only if the deadline is this many minutes away


def check() -> int:
    """Exit code 0 if the next deadline is inside WINDOW minutes, else 1 (the workflow then stops)."""
    boot = httpx.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30,
                     headers={"User-Agent": "Mozilla/5.0"}).json()
    now = datetime.now(timezone.utc)
    upcoming = sorted(d for e in boot["events"]
                      if (d := datetime.fromisoformat(e["deadline_time"].replace("Z", "+00:00"))) > now)
    if not upcoming:
        return 1
    mins = (upcoming[0] - now).total_seconds() / 60
    print(f"Next deadline in {mins:.0f} min")
    return 0 if WINDOW[0] <= mins <= WINDOW[1] else 1


if __name__ == "__main__":
    sys.exit(check())
