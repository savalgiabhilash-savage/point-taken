"""Phase 7 news ingestion: fetch recent per-player headlines from Google News RSS.

No API key required — Google News exposes a public RSS search feed. We behave politely
(a real User-Agent + ~1 request/second throttle) and only ever query a bounded set of
players (see news_job), because each fetch feeds a downstream Claude classification call.

The RSS feed returns generic web headlines, so a query for a common surname can pull in the
wrong "James". We disambiguate with the club name in the query, and the classifier
(sentiment.py) is told to ignore anything not clearly about this footballer.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus
from xml.etree import ElementTree

import httpx

# Google News RSS search endpoint (UK edition, English).
RSS_SEARCH = "https://news.google.com/rss/search"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "fpl-selector/0.1 (personal FPL tool)"
)


@dataclass
class Headline:
    title: str
    url: str
    source: str | None
    published_at: datetime | None


def player_query(web_name: str, team_name: str | None) -> str:
    """Build a disambiguating query: the player, their club, and football context."""
    club = f" {team_name}" if team_name else ""
    return f'"{web_name}"{club} football (injury OR fitness OR lineup OR transfer OR Premier League)'


class NewsClient:
    def __init__(self, min_interval: float = 1.0, timeout: float = 20.0) -> None:
        self.min_interval = min_interval
        self._last = 0.0
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml"},
            timeout=timeout,
            follow_redirects=True,
        )

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last = time.monotonic()

    def fetch(
        self,
        web_name: str,
        team_name: str | None,
        limit: int = 5,
        max_age_days: int = 21,
    ) -> list[Headline]:
        """Return up to `limit` recent headlines (newest first) within `max_age_days`."""
        q = player_query(web_name, team_name)
        url = f"{RSS_SEARCH}?q={quote_plus(q)}&hl=en-GB&gl=GB&ceid=GB:en"
        self._throttle()
        try:
            resp = self._client.get(url)
            resp.raise_for_status()
            root = ElementTree.fromstring(resp.content)
        except (httpx.HTTPError, ElementTree.ParseError) as exc:
            print(f"    news fetch failed for {web_name!r}: {exc}")
            return []

        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
        out: list[Headline] = []
        for item in root.iterfind(".//item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            if not title or not link:
                continue
            src_el = item.find("source")
            source = (src_el.text or "").strip() if src_el is not None else None
            published = _parse_date(item.findtext("pubDate"))
            if published is not None and published < cutoff:
                continue
            out.append(Headline(title=title, url=link, source=source, published_at=published))

        out.sort(key=lambda h: h.published_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return out[:limit]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "NewsClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
