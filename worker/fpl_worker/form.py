"""Preseason form factor from the 2026 World Cup (FBref) — a small, bounded multiplier on a player's
attacking output, blended into the xPts model until the domestic season provides live data.

Why only the World Cup: no structured source reliably covers preseason club friendlies (soccerdata's
FBref exposes leagues + major internationals only), so friendlies are intentionally excluded — the
2026 World Cup is the best recent competitive signal available. The weight is deliberately small
(±12% cap) because a tournament is a small sample in a different context to club football.

One-off (the tournament is complete), run locally — FBref scrapes via a headless browser, so this is
NOT part of the CI cron; the model just reads the stored factors:

    python -m fpl_worker.form --run          # fetch, match, write preseason_form
    python -m fpl_worker.form --dry-run       # fetch + match + print, no DB write
"""

from __future__ import annotations

import argparse

import soccerdata as sd
from dotenv import load_dotenv
from rapidfuzz import fuzz, process

from . import db

WC_SEASON = "2026"
FORM_WEIGHT = 0.12          # max swing on attacking output — deliberately small
GA90_REF = 0.35            # baseline goal-involvements per 90 an involved attacker clears
MIN_WC_MINUTES = 90        # ignore cameo samples (< ~one full match)
CLAMP = (0.90, 1.12)       # bounded; form never dominates the last-season prior
MATCH_THRESHOLD = 86       # fuzzy name-match cutoff (0-100)


def _norm(s: object) -> str:
    return "".join(ch for ch in str(s).lower() if ch.isalpha() or ch == " ").strip()


def world_cup_stats() -> list[dict]:
    """Per-player 2026 World Cup: minutes, goals, assists, club (for context)."""
    fb = sd.FBref(leagues="INT-World Cup", seasons=WC_SEASON)
    df = fb.read_player_season_stats(stat_type="standard").reset_index()
    out = []
    for _, r in df.iterrows():
        out.append({
            "player": r[("player", "")],
            "club": r[("Club", "")],
            "min": float(r[("Playing Time", "Min")] or 0),
            "g": float(r[("Performance", "Gls")] or 0),
            "a": float(r[("Performance", "Ast")] or 0),
        })
    return out


def compute(sb) -> list[dict]:
    players = sb.table("players").select("fpl_id, web_name, full_name").execute().data
    inv = [(p["fpl_id"], _norm(p.get("full_name") or p.get("web_name"))) for p in players]
    inv = [(fid, nm) for fid, nm in inv if nm]
    names = [nm for _, nm in inv]

    by_id: dict[int, dict] = {}
    for w in world_cup_stats():
        if w["min"] < MIN_WC_MINUTES:
            continue
        q = _norm(w["player"])
        if not q:
            continue
        best = process.extractOne(q, names, scorer=fuzz.token_sort_ratio, score_cutoff=MATCH_THRESHOLD)
        if not best:
            continue
        fid = inv[best[2]][0]
        n90 = w["min"] / 90.0
        ga90 = (w["g"] + w["a"]) / n90 if n90 > 0 else 0.0
        conf = min(1.0, w["min"] / 270.0)                 # full confidence at ~3 full games
        raw = max(-0.5, min(0.8, ga90 - GA90_REF))         # over/under the involved-attacker baseline
        mult = max(CLAMP[0], min(CLAMP[1], 1.0 + FORM_WEIGHT * conf * raw))
        row = {
            "player_id": fid,
            "form_mult": round(mult, 3),
            "source": "wc2026",
            "detail": {"wc_player": w["player"], "club": w["club"], "min": round(w["min"]),
                       "goals": round(w["g"]), "assists": round(w["a"]), "ga90": round(ga90, 2),
                       "match_score": round(best[1], 1)},
        }
        # If two WC players fuzzy-match one FPL player, keep the higher-confidence match.
        cur = by_id.get(fid)
        if cur is None or row["detail"]["match_score"] > cur["detail"]["match_score"]:
            by_id[fid] = row
    return list(by_id.values())


def run(sb, dry_run: bool = False) -> None:
    rows = compute(sb)
    boosted = [r for r in rows if r["form_mult"] > 1.0]
    damped = [r for r in rows if r["form_mult"] < 1.0]
    print(f"Matched {len(rows)} FPL players to 2026 World Cup form "
          f"({len(boosted)} boosted, {len(damped)} damped).")
    for r in sorted(rows, key=lambda x: -x["form_mult"])[:12]:
        d = r["detail"]
        print(f"  x{r['form_mult']:.3f}  {d['wc_player'][:22]:22} {d['goals']}G {d['assists']}A "
              f"in {d['min']}min (ga90={d['ga90']}, match={d['match_score']})")
    if dry_run:
        print("(dry run — no DB write)")
        return
    sb.table("preseason_form").delete().neq("player_id", -1).execute()
    if rows:
        db.upsert(sb, "preseason_form", rows, on_conflict="player_id")
    print(f"Wrote {len(rows)} preseason_form rows.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Preseason (World Cup) form factor.")
    parser.add_argument("--run", action="store_true", help="write preseason_form to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="compute + print, no DB write")
    args = parser.parse_args()
    load_dotenv()
    run(db.get_client(), dry_run=args.dry_run or not args.run)


if __name__ == "__main__":
    main()
