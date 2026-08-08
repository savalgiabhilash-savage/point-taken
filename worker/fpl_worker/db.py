"""Supabase writes for the worker.

Uses the service-role key (server-side only — never shipped to the browser). Upserts are
keyed on each table's fpl_id primary key so re-running --refresh is idempotent.
"""

from __future__ import annotations

import os

from supabase import Client, create_client


def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
            "(see worker/.env.example)"
        )
    return create_client(url, key)


def upsert(
    client: Client,
    table: str,
    rows: list[dict],
    on_conflict: str = "fpl_id",
    chunk_size: int = 500,
) -> int:
    """Upsert rows in chunks; returns the number of rows sent."""
    if not rows:
        return 0
    for start in range(0, len(rows), chunk_size):
        batch = rows[start : start + chunk_size]
        client.table(table).upsert(batch, on_conflict=on_conflict).execute()
    return len(rows)
