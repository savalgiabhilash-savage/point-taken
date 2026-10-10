"""Phase 7 news & sentiment job: ingest per-player news, classify with Claude, store the
advisory signals in news_sentiment.

    python -m fpl_worker.news_job --dry-run              # fetch + classify a few, print, no DB write
    python -m fpl_worker.news_job --run                  # full run -> news_sentiment
    python -m fpl_worker.news_job --run --limit 200      # cap players (cost control)

Targets only players where availability/rotation news actually moves the needle — those with
an FPL flag (injured / doubtful / suspended / unavailable) plus the most-owned players — then
caps the total. This bounds both the Google News fetches and the Claude classification calls.
Players with no relevant news are skipped, so the table stays a set of real signals.

Requires ANTHROPIC_API_KEY (see worker/.env.example). Sentiment is ADVISORY (CLAUDE.md): the
signals are surfaced in the UI but not folded into the xPts model.
"""

from __future__ import annotations

import argparse

from dotenv import load_dotenv

from . import db, news, sentiment

# Own% at/above this is "highly-owned" and worth watching even without an FPL flag.
OWN_THRESHOLD = 5.0
DEFAULT_LIMIT = 200
FLAG_STATUSES = {"d", "i", "s", "u", "n"}  # anything other than 'a' available


def load_targets(sb, limit: int) -> tuple[list[dict], int]:
    rows = (
        sb.table("players")
        .select(
            "fpl_id, web_name, status, chance_of_playing_next_round, "
            "selected_by_percent, team:teams(name)"
        )
        .execute()
        .data
    )
    scored = []
    for r in rows:
        own = r.get("selected_by_percent") or 0.0
        flagged = (r.get("status") in FLAG_STATUSES) or (
            r.get("chance_of_playing_next_round") is not None
        )
        if not flagged and own < OWN_THRESHOLD:
            continue
        team = r.get("team") or {}
        scored.append(
            {
                "fpl_id": r["fpl_id"],
                "web_name": r["web_name"],
                "team_name": team.get("name"),
                "flagged": flagged,
                "own": own,
            }
        )
    # Flagged players first, then by ownership — the players a manager is most likely to hold.
    scored.sort(key=lambda p: (not p["flagged"], -p["own"]))
    return scored[:limit], len(scored)


def run(sb, limit: int = DEFAULT_LIMIT, dry_run: bool = False) -> None:
    targets, total = load_targets(sb, limit)
    if total > limit:
        print(f"{total} players qualify; classifying the top {limit} (flagged + most-owned).")
    else:
        print(f"Classifying {len(targets)} players (flagged + owned >= {OWN_THRESHOLD}%).")

    client = sentiment.get_client()
    rows: list[dict] = []
    with_news = 0
    failed = 0

    with news.NewsClient() as nc:
        for i, p in enumerate(targets, 1):
            headlines = nc.fetch(p["web_name"], p["team_name"])
            if not headlines:
                continue
            with_news += 1
            res = sentiment.classify(client, p["web_name"], p["team_name"], headlines)
            if not res:
                failed += 1
                continue
            if res["topics"] == ["none"]:
                continue  # no FPL-relevant signal — don't store noise
            top = headlines[0]
            rows.append(
                {
                    "player_id": p["fpl_id"],
                    "source": top.source or "Google News",
                    "url": top.url,
                    "published_at": top.published_at.isoformat() if top.published_at else None,
                    "sentiment": res["sentiment"],
                    "topics": res["topics"],
                    "summary": res["summary"],
                    "minutes_risk_adj": res["minutes_risk_adj"],
                }
            )
            if dry_run:
                risk = res["minutes_risk_adj"]
                tag = f" risk {risk:+.2f}" if risk else ""
                print(f"  [{i}/{len(targets)}] {p['web_name']:18} {res['sentiment']:8} "
                      f"{','.join(res['topics'])}{tag}  — {res['summary']}")

    print(f"\n{with_news} players had recent news; {len(rows)} carry an FPL-relevant signal.")

    if dry_run:
        return

    # If most classifications failed (API down, out of credits), keep the last good set instead of wiping it.
    if with_news and failed > with_news / 2:
        raise SystemExit(f"{failed}/{with_news} classifications failed; kept the existing news_sentiment rows.")

    # No natural key on news_sentiment (identity id), so replace the whole set each run.
    sb.table("news_sentiment").delete().gt("id", 0).execute()
    if rows:
        sb.table("news_sentiment").insert(rows).execute()
    print(f"Wrote {len(rows)} news_sentiment rows.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 7 news & sentiment job.")
    parser.add_argument("--run", action="store_true", help="write news_sentiment to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="fetch + classify + print, no DB write")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="max players to classify")
    args = parser.parse_args()

    load_dotenv()
    sb = db.get_client()
    run(sb, limit=args.limit, dry_run=args.dry_run or not args.run)


if __name__ == "__main__":
    main()
