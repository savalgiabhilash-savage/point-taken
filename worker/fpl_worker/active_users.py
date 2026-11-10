"""Which registered users the scheduled jobs (team sync + optimizer) work for.

Scheduled runs only sync and re-optimize users seen on the site in the last ACTIVE_DAYS days, so GitHub
Actions minutes (and FPL API calls) grow with active users, not with everyone who ever signed up. The site
records `profiles.last_seen_at` (at most once per 6 hours per user, see web/lib/supabase/middleware.ts) and
starts a re-optimize for a user who comes back after a longer gap, so a returning user's plan is fresh within
a minute or two. The on-demand Sync and Re-optimize buttons work for everyone regardless.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

ACTIVE_DAYS = 7


def active_profiles(sb) -> list[dict]:
    """Profiles with an FPL entry whose owner was seen in the last ACTIVE_DAYS days.

    Before migration 0013 adds `last_seen_at`, every profile with an entry counts as active (no one is
    dropped by accident). A profile with no `last_seen_at` yet also counts as active.
    """
    try:
        rows = sb.table("profiles").select("id, fpl_entry_id, last_seen_at").execute().data
    except Exception:  # noqa: BLE001 — column not there yet (migration 0013 not run): treat all as active
        rows = sb.table("profiles").select("id, fpl_entry_id").execute().data
    cutoff = datetime.now(timezone.utc) - timedelta(days=ACTIVE_DAYS)
    out, skipped = [], 0
    for p in rows:
        if not p.get("fpl_entry_id"):
            continue
        seen = p.get("last_seen_at")
        if seen and datetime.fromisoformat(seen.replace("Z", "+00:00")) < cutoff:
            skipped += 1
            continue
        out.append(p)
    if skipped:
        print(f"Skipping {skipped} user(s) not seen in {ACTIVE_DAYS} days (they re-optimize when they return).")
    return out
