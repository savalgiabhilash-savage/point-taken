"""CLI entrypoint: pull the FPL API and upsert teams/players/fixtures into Supabase.

    uv run python -m fpl_worker.refresh --refresh      # live fetch + write to Supabase
    uv run python -m fpl_worker.refresh --dry-run       # fetch + transform, print counts, no DB
    uv run python -m fpl_worker.refresh --dry-run --from-cache  # use cached JSON, no network
"""

from __future__ import annotations

import argparse
import json

from dotenv import load_dotenv

from . import db, transform
from .fpl_client import FplClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh FPL data into Supabase.")
    parser.add_argument(
        "--refresh", action="store_true", help="fetch live and write to Supabase (default)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="fetch + transform + print, but do not write to DB"
    )
    parser.add_argument(
        "--from-cache", action="store_true", help="read the last cached JSON instead of the network"
    )
    args = parser.parse_args()

    load_dotenv()

    with FplClient() as client:
        print("Fetching bootstrap-static + fixtures ...")
        bootstrap = client.bootstrap_static(from_cache=args.from_cache)
        fixtures = client.fixtures(from_cache=args.from_cache)

    teams = transform.teams_rows(bootstrap)
    players = transform.players_rows(bootstrap)
    fixtures_data = transform.fixtures_rows(fixtures)

    print(f"  teams:    {len(teams)}")
    print(f"  players:  {len(players)}")
    print(f"  fixtures: {len(fixtures_data)}")

    if args.dry_run:
        print("\n--dry-run: sample player row:")
        sample = next((p for p in players if p["web_name"]), players[0])
        print(json.dumps(sample, indent=2))
        return

    print("\nUpserting into Supabase ...")
    supabase = db.get_client()
    # Order matters: players and fixtures reference teams via foreign keys.
    print(f"  teams:    {db.upsert(supabase, 'teams', teams)}")
    print(f"  players:  {db.upsert(supabase, 'players', players)}")
    print(f"  fixtures: {db.upsert(supabase, 'fixtures', fixtures_data)}")
    print("Done.")


if __name__ == "__main__":
    main()
