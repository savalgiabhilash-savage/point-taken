"""Thin HTTP client for the official Fantasy Premier League API.

The FPL API is unauthenticated GET-JSON and undocumented/fragile, so we behave politely:
a real User-Agent, ~1 request/second throttle, retry-with-backoff on 5xx/network errors,
and an on-disk cache of the raw responses (handy for offline transform testing).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

BASE_URL = "https://fantasy.premierleague.com/api/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "fpl-selector/0.1 (personal FPL tool)"
)


class FplClient:
    def __init__(
        self,
        cache_dir: Path | str = ".cache",
        min_interval: float = 1.0,
        timeout: float = 30.0,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.min_interval = min_interval
        self._last_request = 0.0
        self._client = httpx.Client(
            base_url=BASE_URL,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=timeout,
        )

    # -- internals -----------------------------------------------------------
    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_request = time.monotonic()

    def _cache_path(self, key: str) -> Path:
        safe = key.strip("/").replace("/", "_") or "root"
        return self.cache_dir / f"{safe}.json"

    def _get(self, path: str, retries: int = 4) -> dict | list:
        last_exc: Exception | None = None
        for attempt in range(retries):
            self._throttle()
            try:
                resp = self._client.get(path)
                if resp.status_code >= 500:
                    raise httpx.HTTPStatusError(
                        f"server error {resp.status_code}", request=resp.request, response=resp
                    )
                resp.raise_for_status()
                data = resp.json()
                self._cache_path(path).write_text(
                    json.dumps(data), encoding="utf-8"
                )
                return data
            except (httpx.HTTPStatusError, httpx.TransportError) as exc:
                last_exc = exc
                backoff = 2**attempt
                print(f"  fetch {path!r} failed ({exc}); retrying in {backoff}s")
                time.sleep(backoff)
        raise RuntimeError(f"giving up on {path!r} after {retries} attempts") from last_exc

    def _from_cache(self, path: str) -> dict | list:
        cached = self._cache_path(path)
        if not cached.exists():
            raise FileNotFoundError(f"no cached response for {path!r} at {cached}")
        return json.loads(cached.read_text(encoding="utf-8"))

    # -- endpoints -----------------------------------------------------------
    def bootstrap_static(self, from_cache: bool = False) -> dict:
        path = "bootstrap-static/"
        return self._from_cache(path) if from_cache else self._get(path)  # type: ignore[return-value]

    def fixtures(self, from_cache: bool = False) -> list:
        path = "fixtures/"
        return self._from_cache(path) if from_cache else self._get(path)  # type: ignore[return-value]

    def element_summary(self, player_id: int, from_cache: bool = False) -> dict:
        path = f"element-summary/{player_id}/"
        return self._from_cache(path) if from_cache else self._get(path)  # type: ignore[return-value]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "FplClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
