"""
Fast Path (Path A) — existing ReAct agent with a 30 s hard timeout.
Returns ScrapeResult with scrape_strategy="fast". Never raises.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

import agents.scraper_agent as scraper_agent
from models.types import ScrapeResult, Venue

_TIMEOUT_S = 30


def scrape(venue: Venue) -> ScrapeResult:
    """Run Path A within 30 s. Returns a timed-out ScrapeResult if it exceeds the limit."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(scraper_agent.scrape, venue)
        try:
            result: ScrapeResult = future.result(timeout=_TIMEOUT_S)
        except FuturesTimeout:
            future.cancel()
            result = ScrapeResult(
                venue_id=venue.id,
                success=False,
                error="fast path timeout",
            )
        except Exception as exc:
            result = ScrapeResult(
                venue_id=venue.id,
                success=False,
                error=str(exc),
            )

    result.scrape_strategy = "fast"
    return result
