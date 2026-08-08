"""Phase 2 enrichment CLI: resolve the FPL<->Understat crosswalk (and, later, custom FDR).

    python -m fpl_worker.enrich --crosswalk
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from dotenv import load_dotenv

from . import crosswalk, db, fdr, soccer_stats

REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"


def load_fpl_players(sb) -> list[dict]:
    rows = (
        sb.table("players")
        .select("fpl_id, web_name, full_name, first_name, second_name, position, team:teams(name)")
        .execute()
        .data
    )
    out = []
    for r in rows:
        team = r.get("team") or {}
        out.append(
            {
                "fpl_id": r["fpl_id"],
                "web_name": r["web_name"],
                "full_name": r["full_name"],
                "first_name": r.get("first_name"),
                "second_name": r.get("second_name"),
                "position": r["position"],
                "team_name": team.get("name"),
            }
        )
    return out


def run_crosswalk(sb) -> None:
    print(f"Fetching Understat player-season stats ({soccer_stats.BASELINE_SEASON} = 2025/26) ...")
    us_df = soccer_stats.understat_player_season()
    fpl = load_fpl_players(sb)

    matches, review = crosswalk.build(fpl, us_df)
    n_global = sum(1 for m in matches if m.get("source") == "global")
    print(f"  matched (confident): {len(matches)}  ({n_global} via global/transfer fallback)")
    print(f"  to review:           {len(review)}")

    # Clear any prior understat_id so a re-run is idempotent (dropped matches don't linger).
    sb.table("players").update({"understat_id": None}).gt("fpl_id", 0).execute()

    # Persist understat_id on matched players. web_name is included so the upsert's INSERT
    # arm satisfies the NOT NULL constraint; only these columns are written.
    rows = [
        {"fpl_id": m["fpl_id"], "web_name": m["web_name"], "understat_id": m["understat_id"]}
        for m in matches
    ]
    db.upsert(sb, "players", rows, on_conflict="fpl_id")

    REPORTS_DIR.mkdir(exist_ok=True)
    path = REPORTS_DIR / "crosswalk_review.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "fpl_id", "fpl_name", "full_name", "team", "position",
                "reason", "candidates", "best_score",
            ],
        )
        writer.writeheader()
        writer.writerows(review)
    print(f"  review CSV -> {path}")

    # Auditable record of accepted matches (esp. the global/transfer ones).
    match_path = REPORTS_DIR / "crosswalk_matches.csv"
    with match_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["fpl_id", "web_name", "understat_name", "understat_id", "score", "source"]
        )
        writer.writeheader()
        writer.writerows(sorted(matches, key=lambda m: m["source"]))
    print(f"  matches CSV -> {match_path}")

    # Quick breakdown of why rows need review.
    reasons: dict[str, int] = {}
    for r in review:
        key = r["reason"].split(" ")[0]
        reasons[key] = reasons.get(key, 0) + 1
    print("  review reasons:", reasons)


def run_fdr(sb) -> None:
    print(f"Computing custom FDR from Understat team xG ({soccer_stats.BASELINE_SEASON} = 2025/26) ...")
    ratings = fdr.team_ratings()
    fpl_teams = sb.table("teams").select("fpl_id, name").execute().data
    fixtures = sb.table("fixtures").select("fpl_id, team_h, team_a").execute().data

    rows = fdr.compute_fdr(fpl_teams, fixtures, ratings)
    db.upsert(sb, "fixtures", rows, on_conflict="fpl_id")
    print(f"  custom FDR written for {len(rows)} fixtures")

    # Sanity: strongest/weakest teams by last-season xG rating.
    ranked = sorted(
        ((t["name"], ratings.get(t["name"])) for t in fpl_teams),
        key=lambda x: (x[1] or {}).get("rating", -99),
        reverse=True,
    )
    print("  team xG rating (xGF/g - xGA/g), top 5 / bottom 5:")
    for name, r in ranked[:5] + ranked[-5:]:
        if r:
            print(f"    {name:16} rating {r['rating']:+.2f}  (xGF {r['xgf_pg']:.2f} / xGA {r['xga_pg']:.2f})")
        else:
            print(f"    {name:16} (promoted — fallback rating)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 2 enrichment (crosswalk, FDR).")
    parser.add_argument("--crosswalk", action="store_true", help="resolve FPL<->Understat crosswalk")
    parser.add_argument("--fdr", action="store_true", help="compute custom FDR from team xG")
    parser.add_argument("--all", action="store_true", help="run everything")
    args = parser.parse_args()

    load_dotenv()
    sb = db.get_client()

    ran = False
    if args.crosswalk or args.all:
        run_crosswalk(sb)
        ran = True
    if args.fdr or args.all:
        run_fdr(sb)
        ran = True
    if not ran:
        parser.print_help()


if __name__ == "__main__":
    main()
