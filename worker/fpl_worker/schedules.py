"""Non-league fixtures for English clubs (Champions League, Europa League, Conference League, FA Cup,
League Cup) from ESPN's public scoreboard API — the input for fixture congestion and rest (factors 6/7).

ESPN only answers one date per request, so a date range is fetched day by day in parallel. Past seasons
are cached under .cache/espn; live runs fetch just the window around the next few gameweeks.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import httpx

COMPETITIONS = ["uefa.champions", "uefa.europa", "uefa.europa.conf", "eng.fa", "eng.league_cup"]
URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/{comp}/scoreboard?dates={day}"
CACHE = Path(".cache") / "espn"

# ESPN display names -> the FPL form (others match after normalising or as a prefix).
ALIASES = {
    "manchester united": "man utd", "manchester city": "man city", "tottenham hotspur": "spurs",
    "newcastle united": "newcastle", "nottingham forest": "nott'm forest", "wolverhampton wanderers": "wolves",
    "brighton & hove albion": "brighton", "brighton and hove albion": "brighton", "west ham united": "west ham",
    "leeds united": "leeds", "leicester city": "leicester", "afc bournemouth": "bournemouth",
    "sheffield united": "sheffield utd", "luton town": "luton",
}


def _norm(name: str) -> str:
    n = name.lower().replace("fc", "").replace("afc ", "afc ").strip()
    return re.sub(r"\s+", " ", n)


def fpl_team(espn_name: str, fpl_names: list[str]) -> str | None:
    """Map an ESPN club name to an FPL team name, or None if it isn't a Premier League club."""
    n = _norm(espn_name)
    n = ALIASES.get(n, n)
    lower = {f.lower(): f for f in fpl_names}
    if n in lower:
        return lower[n]
    for low, f in lower.items():  # "ipswich" vs "Ipswich Town", "coventry city" vs "Coventry City"
        if low.startswith(n + " ") or n.startswith(low + " "):
            return f
    return None


def _day(client: httpx.Client, comp: str, day: date) -> list[tuple[str, list[str]]]:
    try:
        r = client.get(URL.format(comp=comp, day=day.strftime("%Y%m%d")))
        if r.status_code != 200:
            return []
        out = []
        for e in r.json().get("events", []):
            teams = [c["team"]["displayName"] for c in e["competitions"][0]["competitors"]]
            out.append((e["date"][:10], teams))
        return out
    except Exception:  # noqa: BLE001 — a missing day just means no congestion information for it
        return []


def fetch(start: date, end: date) -> list[dict]:
    """[{date, team (ESPN name), comp}] for every match in the competitions between start and end."""
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    jobs = [(c, d) for c in COMPETITIONS for d in days]
    with httpx.Client(timeout=20, headers={"User-Agent": "Mozilla/5.0 fpl-selector"}) as client:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda j: (j[0], _day(client, *j)), jobs))
    seen, out = set(), []
    for comp, events in results:
        for d, teams in events:
            for t in teams:
                if (d, t) not in seen:
                    seen.add((d, t))
                    out.append({"date": d, "team": t, "comp": comp})
    return out


def season_matches(season: str, start: date, end: date) -> list[dict]:
    """Cached fetch for a whole past season."""
    path = CACHE / f"{season}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    rows = fetch(start, end)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows), encoding="utf-8")
    return rows


def team_dates(other: list[dict], league: list[tuple[str, str]], fpl_names: list[str]) -> dict[str, list[date]]:
    """{FPL team name: sorted match dates across all competitions}. `league` is [(team, 'YYYY-MM-DD')]."""
    out: dict[str, set[date]] = {}
    for t, d in league:
        out.setdefault(t, set()).add(date.fromisoformat(d[:10]))
    for m in other:
        t = fpl_team(m["team"], fpl_names)
        if t:
            out.setdefault(t, set()).add(date.fromisoformat(m["date"]))
    return {t: sorted(ds) for t, ds in out.items()}
