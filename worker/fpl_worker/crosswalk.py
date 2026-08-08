"""Resolve the FPL <-> Understat player-ID crosswalk by fuzzy name match.

No shared key exists, so this is the #1 integration pain. Two passes:

1. Team-constrained pass — candidates limited to the player's club (after mapping team-name
   variants). Score each with token_sort_ratio on the full name (conservative — a shared
   middle-name token like "Silva"/"Nunes" does NOT inflate it the way token_set_ratio does),
   plus a structured bonus when a SURNAME token matches AND the first name is compatible
   (catches "Ben"↔"Benjamin", "Tino"↔"Valentino"; rejects "Vitor"↔"Matheus").

2. Global fallback — for players still unmatched, search ALL Understat players with a high
   bar (score + big uniqueness margin). This catches summer transfers, whose last-season data
   sits under their OLD club.

Auto-accept only past the thresholds; everything else goes to a review CSV for the human.
"""

from __future__ import annotations

import re
import unicodedata

import pandas as pd
from rapidfuzz import fuzz

# Understat 2025/26 team name -> FPL 2026/27 team name (only the ones that differ).
UNDERSTAT_TO_FPL_TEAM = {
    "Manchester City": "Man City",
    "Manchester United": "Man Utd",
    "Newcastle United": "Newcastle",
    "Nottingham Forest": "Nott'm Forest",
    "Tottenham": "Spurs",
}

CONFIDENT_SCORE = 85  # team-pass threshold (rapidfuzz 0-100)
UNIQUE_MARGIN = 6     # best must beat 2nd-best by this much -> else "ambiguous"
STRUCTURED = 91       # score for a confident surname + first-name agreement
GLOBAL_SCORE = 92     # global-fallback threshold (stricter — no team constraint)
GLOBAL_MARGIN = 8


def normalize(s: str | None) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _us_team_to_fpl(name: str) -> str:
    return UNDERSTAT_TO_FPL_TEAM.get(name, name)


def _first_names_compatible(a: str, b: str) -> bool:
    """e.g. ben~benjamin, tino~valentino, joe~joseph — but vitor≠matheus, igor≠maxim."""
    if not a or not b:
        return False
    return a[0] == b[0] or a in b or b in a or fuzz.ratio(a, b) >= 60


def _surname_match(fpl_last_tokens: list[str], cand_tokens: list[str]) -> bool:
    """True if any FPL surname token matches any candidate token (handles double surnames
    like 'Raya Martín' vs 'Raya')."""
    for t in fpl_last_tokens:
        for ct in cand_tokens:
            if len(t) >= 4 and fuzz.ratio(t, ct) >= 88:
                return True
    return False


def _score(fp: dict, c: dict) -> float:
    base = max(
        fuzz.token_sort_ratio(fp["full"], c["norm"]),
        fuzz.token_sort_ratio(fp["web"], c["norm"]),
        fuzz.partial_ratio(fp["web"], c["norm"]) if len(fp["web"]) >= 5 else 0,
    )
    if _surname_match(fp["last_tokens"], c["tokens"]) and _first_names_compatible(
        fp["first"], c["first"]
    ):
        base = max(base, STRUCTURED)
    return base


def _global_score(fp: dict, c: dict) -> float:
    # No team constraint -> demand strong FULL-name agreement. Surname-only (web partial)
    # is too weak globally: many players share a surname (Abu vs Boubacar Kamara).
    return float(fuzz.token_sort_ratio(fp["full"], c["norm"]))


def _prep_fpl(p: dict) -> dict:
    last = normalize(p.get("second_name"))
    return {
        "full": normalize(p["full_name"]),
        "web": normalize(p["web_name"]),
        "first": normalize(p.get("first_name")),
        "last_tokens": [t for t in last.split() if len(t) >= 3],
    }


def _prep_candidate(name: str, understat_id: str) -> dict:
    norm = normalize(name)
    toks = norm.split()
    return {
        "understat_id": understat_id,
        "name": name,
        "norm": norm,
        "tokens": toks,
        "first": toks[0] if toks else "",
    }


def _best_two(fp: dict, cands: list[dict], scorer=_score) -> tuple[float, dict | None, float]:
    scored = sorted(((scorer(fp, c), c) for c in cands), key=lambda x: x[0], reverse=True)
    if not scored:
        return 0.0, None, 0.0
    best_score, best = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    return best_score, best, second


def _match(p: dict, cand: dict, score: float, source: str) -> dict:
    return {
        "fpl_id": p["fpl_id"],
        "web_name": p["web_name"],  # carried so the DB upsert satisfies NOT NULL
        "understat_id": cand["understat_id"],
        "understat_name": cand["name"],
        "score": round(score, 1),
        "source": source,
    }


def _review_row(p: dict, reason: str, candidate: str, score) -> dict:
    return {
        "fpl_id": p["fpl_id"],
        "fpl_name": p["web_name"],
        "full_name": p["full_name"],
        "team": p["team_name"],
        "position": p["position"],
        "reason": reason,
        "candidates": candidate,
        "best_score": score,
    }


def build(fpl_players: list[dict], understat_df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    """Return (matches, review). fpl_players need fpl_id, web_name, full_name, first_name,
    second_name, position, team_name. understat_df is the reset-index player-season frame."""
    us = understat_df.copy()
    us["fpl_team"] = us["team"].map(_us_team_to_fpl)

    by_team: dict[str, list[dict]] = {}
    all_cands: list[dict] = []
    for _, r in us.iterrows():
        cand = _prep_candidate(r["player"], str(r["player_id"]))
        by_team.setdefault(r["fpl_team"], []).append(cand)
        all_cands.append(cand)

    matches: list[dict] = []
    unmatched: list[tuple[dict, dict, list]] = []  # (player, fp-prep, team-pass scored top-3)

    # Pass 1: team-constrained.
    for p in fpl_players:
        fp = _prep_fpl(p)
        cands = by_team.get(p["team_name"], [])
        best_score, best, second = _best_two(fp, cands)
        if best and best_score >= CONFIDENT_SCORE and (best_score - second) >= UNIQUE_MARGIN:
            matches.append(_match(p, best, best_score, "team"))
        else:
            top = sorted(((_score(fp, c), c) for c in cands), key=lambda x: x[0], reverse=True)[:3]
            unmatched.append((p, fp, top))

    # Pass 2: global fallback (transfers) for whatever pass 1 left.
    review: list[dict] = []
    for p, fp, team_top in unmatched:
        best_score, best, second = _best_two(fp, all_cands, _global_score)
        if best and best_score >= GLOBAL_SCORE and (best_score - second) >= GLOBAL_MARGIN:
            matches.append(_match(p, best, best_score, "global"))
            continue
        # Still unmatched -> explain using the team-pass candidates.
        if not team_top:
            reason = "no_understat_team (promoted club / not in last PL season)"
            cand_str = ""
            score = ""
        else:
            tb = team_top[0][0]
            reason = "low_score" if tb < CONFIDENT_SCORE else "ambiguous_margin"
            cand_str = "; ".join(f"{c['name']} ({s:.0f})" for s, c in team_top)
            score = round(tb, 1)
        review.append(_review_row(p, reason, cand_str, score))

    return matches, review
