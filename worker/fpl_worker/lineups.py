"""Predicted line-ups and managerial changes from the web (accuracy plan factors 13 and 14).

Before each deadline, one Claude call with the web search / web fetch server tools finds this round's
predicted starting XIs for all 20 clubs (round-up articles usually cover every team) and any managerial
change in the last 30 days, then returns them through the strict `record_team_news` tool. Names are
matched to FPL players within each club and stored:
  * predicted_lineups — who is (and who isn't) in each predicted XI; the model moves the next GW's
    start chance toward a start / no start, with a strength learned from outcomes (predict.py);
  * team_context — managerial changes; games before the change count less in that club's form.

Runs only inside LINEUP_WINDOW_HOURS of the deadline (predicted XIs appear 1-2 days before), because
each call costs roughly $0.5-1 (model tokens + searches). Needs ANTHROPIC_API_KEY and migration 0009.

    python -m fpl_worker.lineups --run            # only if the deadline is near
    python -m fpl_worker.lineups --run --force    # regardless of the deadline
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import anthropic
from dotenv import load_dotenv
from rapidfuzz import fuzz, process

from . import db
from .fpl_client import FplClient

MODEL = "claude-opus-5"
LINEUP_WINDOW_HOURS = 48
MATCH_THRESHOLD = 80  # fuzzy name match (0-100) within a club

TOOL = {
    "name": "record_team_news",
    "description": "Record the predicted starting XI for each Premier League club this gameweek and any managerial change.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["teams"],
        "properties": {
            "teams": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["team", "predicted_xi", "confidence", "source_url", "manager_change"],
                    "properties": {
                        "team": {"type": "string", "description": "Club name as given in the request"},
                        "predicted_xi": {"type": "array", "items": {"type": "string"},
                                         "description": "Surnames of the 11 predicted starters; empty if none found"},
                        "confidence": {"type": "number", "description": "0-1: how reliable/recent the source is"},
                        "source_url": {"type": "string"},
                        "manager_change": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["changed", "date", "new_manager", "summary"],
                            "properties": {
                                "changed": {"type": "boolean", "description": "New manager/head coach in the last 30 days"},
                                "date": {"type": "string", "description": "YYYY-MM-DD of the change, or empty"},
                                "new_manager": {"type": "string"},
                                "summary": {"type": "string"},
                            },
                        },
                    },
                },
            },
        },
    },
}


def _prompt(gw: int, fixtures: list[str], team_names: list[str], today: str) -> str:
    return (
        f"Today is {today}. Premier League gameweek {gw} fixtures: {'; '.join(fixtures)}.\n\n"
        "Use web search (and fetch articles where needed) to find the most recent PREDICTED STARTING XIs for "
        "every club in these fixtures, from reputable football sources published in the last 3 days "
        "(round-up articles covering all teams are ideal). Also check whether any of these clubs changed "
        "manager/head coach in the last 30 days.\n\n"
        f"Clubs (use these exact names): {', '.join(team_names)}.\n\n"
        "Then call record_team_news once with one entry per club. Use players' surnames as commonly written. "
        "If you find no predicted XI for a club, give an empty list and confidence 0. Do not guess line-ups "
        "that no source gives."
    )


def fetch_team_news(gw: int, fixtures: list[str], team_names: list[str]) -> list[dict]:
    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": _prompt(gw, fixtures, team_names, datetime.now(timezone.utc).date().isoformat())}]
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 4},
        TOOL,
    ]
    for _ in range(4):  # pause_turn continuations
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            tools=tools,
            messages=messages,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            print("  lineups: request declined by the model; skipping this run")
            return []
        for block in resp.content:
            if block.type == "tool_use" and block.name == "record_team_news":
                return json.loads(json.dumps(block.input)).get("teams", [])
        if resp.stop_reason == "pause_turn":
            messages = [messages[0], {"role": "assistant", "content": resp.content}]
            continue
        break
    print(f"  lineups: model finished without recording team news (stop_reason={resp.stop_reason})")
    return []


def _match(names: list[str], squad: list[dict]) -> dict[int, bool]:
    """{player_id: in predicted XI} for this club's squad."""
    keys = [(p["fpl_id"], f"{p['web_name']} {p.get('full_name') or ''}".lower()) for p in squad]
    listed: set[int] = set()
    for n in names:
        hit = process.extractOne(n.lower(), [k for _, k in keys], scorer=fuzz.partial_ratio, score_cutoff=MATCH_THRESHOLD)
        if hit:
            listed.add(keys[hit[2]][0])
    return {pid: pid in listed for pid, _ in keys}


def run(sb, force: bool = False) -> None:
    with FplClient() as client:
        boot = client.bootstrap_static()
    nxt = next((e for e in boot["events"] if e.get("is_next")), None)
    if not nxt:
        print("lineups: no upcoming gameweek")
        return
    deadline = datetime.fromisoformat(nxt["deadline_time"].replace("Z", "+00:00"))
    hours = (deadline - datetime.now(timezone.utc)).total_seconds() / 3600
    if not force and not (0 < hours <= LINEUP_WINDOW_HOURS):
        print(f"lineups: GW{nxt['id']} deadline in {hours:.0f}h — outside the {LINEUP_WINDOW_HOURS}h window, skipping")
        return

    gw = nxt["id"]
    teams = sb.table("teams").select("fpl_id, name").execute().data
    name_by_id = {t["fpl_id"]: t["name"] for t in teams}
    fx = sb.table("fixtures").select("team_h, team_a").eq("gw", gw).execute().data
    fixtures = [f"{name_by_id[f['team_h']]} v {name_by_id[f['team_a']]}" for f in fx]
    playing = sorted({name_by_id[f["team_h"]] for f in fx} | {name_by_id[f["team_a"]] for f in fx})
    players = sb.table("players").select("fpl_id, web_name, full_name, team_id, status").execute().data

    news = fetch_team_news(gw, fixtures, playing)
    id_by_name = {v: k for k, v in name_by_id.items()}
    rows, ctx = [], []
    for t in news:
        tid = id_by_name.get(t["team"])
        if tid is None:
            continue
        if t["predicted_xi"] and t["confidence"] > 0:
            squad = [p for p in players if p["team_id"] == tid and p["status"] not in ("u", "n")]
            for pid, in_xi in _match(t["predicted_xi"], squad).items():
                rows.append({"gw": gw, "team_id": tid, "player_id": pid, "predicted": in_xi,
                             "confidence": round(min(1.0, max(0.0, t["confidence"])), 2), "source": "web",
                             "url": t["source_url"], "published_at": None})
        mc = t["manager_change"]
        if mc["changed"] and mc["date"]:
            ctx.append({"team_id": tid, "manager_changed_at": mc["date"][:10], "manager": mc["new_manager"],
                        "summary": mc["summary"], "source": "web", "url": t["source_url"],
                        "updated_at": datetime.now(timezone.utc).isoformat()})
    try:
        sb.table("predicted_lineups").delete().eq("gw", gw).execute()
        if rows:
            db.upsert(sb, "predicted_lineups", rows, on_conflict="gw,team_id,player_id")
        if ctx:
            db.upsert(sb, "team_context", ctx, on_conflict="team_id")
    except Exception as exc:  # noqa: BLE001 — migration 0009 not applied yet
        print(f"  lineups: couldn't store ({exc.__class__.__name__}); run supabase/migrations/0009")
        return
    covered = len({r["team_id"] for r in rows})
    print(f"lineups GW{gw}: predicted XIs for {covered}/{len(playing)} clubs, {len(ctx)} managerial change(s)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Predicted line-ups + managerial changes (Claude web search).")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--force", action="store_true", help="ignore the deadline window")
    args = parser.parse_args()
    load_dotenv()
    if args.run:
        run(db.get_client(), force=args.force)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
