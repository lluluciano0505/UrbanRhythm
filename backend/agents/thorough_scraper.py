"""
Thorough Path (Path B) — Navigator → Strategy → Extractor pipeline.
Returns ScrapeResult with scrape_strategy="thorough". Never raises.
"""

from __future__ import annotations

from datetime import date

import agents.extractor_agent as extractor_agent
import agents.navigator_agent as navigator_agent
import agents.strategy_agent as strategy_agent
from agents.scraper_tools import fetch_page
from models.types import ScrapeResult, Venue

_EXTRACTOR_CONCURRENCY = 3


def scrape(venue: Venue, homepage_content: str = "") -> ScrapeResult:
    """Run Path B. homepage_content can be pre-supplied to avoid a redundant fetch."""
    try:
        # Step 1 — fetch homepage if not supplied
        if not homepage_content and venue.website:
            homepage_content = fetch_page.invoke({"url": venue.website})

        # Step 2 — Navigator: classify site structure
        site_profile = navigator_agent.profile(homepage_content, venue.website or "")

        # Step 3 — Strategy: pick ordered target URLs
        target_urls = strategy_agent.plan(site_profile, venue.website or "")

        if not target_urls:
            return ScrapeResult(
                venue_id=venue.id,
                success=False,
                error="no target URLs identified",
                scrape_strategy="thorough",
                navigator_profile=site_profile,
                extractor_urls=[],
            )

        # Step 4 — Extractor: parallel mini-agents per URL
        events = extractor_agent.extract_all(
            target_urls, venue.name, venue.city, venue.id, _EXTRACTOR_CONCURRENCY
        )

        today = date.today().isoformat()
        future_events = [e for e in events if e.date >= today]

        return ScrapeResult(
            venue_id=venue.id,
            success=len(future_events) > 0,
            events=future_events,
            strategy_used="thorough_extract" if future_events else None,
            attempts=len(target_urls),
            error=None if future_events else "no future events found",
            scrape_strategy="thorough",
            navigator_profile=site_profile,
            extractor_urls=target_urls,
        )

    except Exception as exc:
        return ScrapeResult(
            venue_id=venue.id,
            success=False,
            error=str(exc),
            scrape_strategy="thorough",
        )
