"""Push notifications (web push): deadline reminders and injury alerts.

  --deadline  Run by the pre-deadline workflow (~100 min before each deadline, after the plan is refreshed):
              "GW12 deadline in 1h 40m: Mbeumo → Le Fée, captain N.Jackson". Sent only when the next deadline is
              under DEADLINE_WINDOW_H hours away, once per user per GW.
  --injuries  Run by the 2-hourly refresh: a player in the user's current squad is newly flagged (FPL status
              not "available", or a different chance of playing). Each status change is sent once. The first
              run for a user only records the current flags, so turning alerts on doesn't send old news.

Who gets what: push_subscriptions (one row per device, with the user's choices); what was sent: push_log.
Needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (the same pair the website uses); without them it does nothing.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from pywebpush import WebPushException, webpush

from . import db

SUBJECT = "https://point-taken-fpl.vercel.app"
DEADLINE_WINDOW_H = 3
STATUS = {"d": "doubtful", "i": "injured", "s": "suspended", "u": "unavailable", "n": "not in the squad"}


def _clean(v: str | None) -> str:
    return "".join(c for c in (v or "") if c != "﻿").strip()


def _subs(sb, pref: str) -> dict[str, list[dict]]:
    """{user_id: [subscription rows]} for users who chose `pref` ('deadline' or 'injuries')."""
    try:
        rows = sb.table("push_subscriptions").select("user_id, endpoint, p256dh, auth").eq(pref, True).execute().data
    except Exception:  # noqa: BLE001 — migration 0017 not applied yet
        print("  notify: push tables missing (migration 0017) — skipped")
        return {}
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["user_id"], []).append(r)
    return out


def _send(sb, subs: list[dict], payload: dict, key: str) -> int:
    sent = 0
    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                data=json.dumps(payload),
                vapid_private_key=key,
                vapid_claims={"sub": SUBJECT},
                ttl=3600,
            )
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # the browser dropped this subscription
                sb.table("push_subscriptions").delete().eq("endpoint", s["endpoint"]).execute()
            else:
                print(f"  notify: send failed ({code})")
    return sent


def _logged(sb, uid: str, kind: str) -> set[str]:
    return {r["ref"] for r in sb.table("push_log").select("ref").eq("user_id", uid).eq("kind", kind).execute().data}


def _log(sb, uid: str, kind: str, refs: list[str], sent: bool) -> None:
    if refs:
        db.upsert(sb, "push_log", [{"user_id": uid, "kind": kind, "ref": r, "sent": sent} for r in refs],
                  on_conflict="user_id,kind,ref")


def deadline(sb, key: str) -> None:
    now = datetime.now(timezone.utc)
    nxt = sb.table("gw_deadlines").select("gw, deadline").gt("deadline", now.isoformat()).order("deadline").limit(1).execute().data
    if not nxt:
        return
    gw, dl = nxt[0]["gw"], datetime.fromisoformat(nxt[0]["deadline"].replace("Z", "+00:00"))
    left = dl - now
    if left.total_seconds() > DEADLINE_WINDOW_H * 3600:
        print(f"  notify: GW{gw} deadline is {left} away — reminders not due yet")
        return
    h, m = int(left.total_seconds() // 3600), int(left.total_seconds() % 3600 // 60)
    ref = f"gw{gw}"
    for uid, subs in _subs(sb, "deadline").items():
        if ref in _logged(sb, uid, "deadline"):
            continue
        run = sb.table("optimizer_runs").select("suggested_squad, transfers").eq("user_id", uid).limit(1).execute().data
        plan = "Check your team before the deadline"
        if run:
            t, squad = run[0].get("transfers") or {}, run[0].get("suggested_squad") or []
            step = (t.get("path") or [None])[0]
            cap = next((p["web_name"] for p in squad if p.get("is_captain")), None)
            if step and step.get("num"):
                moves = ", ".join(f"{o['web_name']} → {i['web_name']}" for o, i in zip(step["out"], step["in"]))
                plan = moves + (f" (−{step['hits'] * 4})" if step.get("hits") else "")
            else:
                plan = "No transfer: roll it"
            if cap:
                plan += f" · captain {cap}"
        n = _send(sb, subs, {"title": f"GW{gw} deadline in {h}h {m:02d}m", "body": plan, "url": "/team", "tag": f"deadline-{gw}"})
        _log(sb, uid, "deadline", [ref], sent=n > 0)
        print(f"  notify: deadline GW{gw} → {uid[:8]} ({n} device(s))")


def injuries(sb, key: str) -> None:
    for uid, subs in _subs(sb, "injuries").items():
        st = sb.table("user_team_state").select("picks").eq("user_id", uid).order("gw", desc=True).limit(1).execute().data
        ids = [p["element"] for p in ((st[0].get("picks") if st else None) or [])]
        if not ids:
            continue
        players = sb.table("players").select(
            "fpl_id, web_name, status, chance_of_playing_next_round, news, team:teams(short_name)").in_("fpl_id", ids).execute().data
        flagged = [p for p in players if (p.get("status") or "a") != "a"]
        refs = {f"{p['fpl_id']}:{p['status']}:{p.get('chance_of_playing_next_round')}": p for p in flagged}
        seen = _logged(sb, uid, "flag")
        if not seen:
            # First run for this user: record today's flags as the starting point, send nothing.
            _log(sb, uid, "flag", list(refs) or ["start"], sent=False)
            continue
        new = [p for r, p in refs.items() if r not in seen]
        if not new:
            continue
        lines = []
        for p in new:
            chance = p.get("chance_of_playing_next_round")
            what = f"{chance}% chance" if chance is not None else STATUS.get(p["status"], "flagged")
            news = (p.get("news") or "").strip()
            lines.append(f"{p['web_name']} ({(p.get('team') or {}).get('short_name', '')}): {what}" + (f", {news}" if news else ""))
        title = f"{new[0]['web_name']} flagged" if len(new) == 1 else f"{len(new)} of your players flagged"
        n = _send(sb, subs, {"title": title, "body": "\n".join(lines)[:300], "url": "/team", "tag": "injuries"})
        _log(sb, uid, "flag", [r for r, p in refs.items() if p in new], sent=n > 0)
        print(f"  notify: {len(new)} flag(s) → {uid[:8]} ({n} device(s))")


def main() -> None:
    parser = argparse.ArgumentParser(description="Push notifications: deadline reminders and injury alerts.")
    parser.add_argument("--deadline", action="store_true")
    parser.add_argument("--injuries", action="store_true")
    args = parser.parse_args()
    load_dotenv()
    key = _clean(os.environ.get("VAPID_PRIVATE_KEY"))
    if not key:
        print("notify: VAPID_PRIVATE_KEY not set — skipped")
        return
    sb = db.get_client()
    if args.deadline:
        deadline(sb, key)
    if args.injuries:
        injuries(sb, key)


if __name__ == "__main__":
    main()
