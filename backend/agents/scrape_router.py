"""
Scrape Router — dual-path routing logic for a single venue.

Routing table:
  fast events >= 3          → accept Path A, skip Path B
  fast events == 0          → escalate to Path B immediately
  fast events in [1, 2]     → run Path B, keep whichever result has more events

ScrapeResult.scrape_strategy values:
  "fast"            → Path A only, found >= 3 events
  "fast+escalated"  → Path B ran (Path A found 0-2), Path B result used
  "fast"            → Path B ran but Path A was already better (events 1-2 case)
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from dataclasses import replace
from datetime import date

from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import json

import agents.fast_scraper as fast_scraper
import agents.thorough_scraper as thorough_scraper
import agents.website_finder as website_finder
from agents.scraper_tools import fetch_page, _search_web_impl
from models.types import RawEvent, ScrapeResult, Venue
import config

_THOROUGH_TIMEOUT_S = 90

_TAVILY_SYSTEM = (
    "You are extracting future events from web search results about a specific venue.\n"
    "Each result has a title, url, and content snippet. Extract any concrete upcoming events.\n"
    "Today: {today}. Only include events with date >= today.\n"
    "Return ONLY a JSON array:\n"
    '[{"title":"...","date":"YYYY-MM-DD","url":"...","description":"..."}]\n'
    "Return [] if no real events are found. No markdown, no explanation."
)


def _tavily_fallback(venue: Venue) -> ScrapeResult:
    """Search the web for venue events when no website is available."""
    query = f'"{venue.name}" {venue.city} events 2025 2026'
    raw_events = _search_web_impl(query)

    today = date.today().isoformat()
    future = [e for e in raw_events if e.date >= today]
    for e in future:
        e.venue_id = venue.id
        e.source_strategy = "tavily"

    result = ScrapeResult(
        venue_id=venue.id,
        success=len(future) > 0,
        events=future,
        strategy_used="tavily_search" if future else None,
        error=None if future else "no events found via web search",
        scrape_strategy="tavily",
    )
    return result


def route(venue: Venue) -> ScrapeResult:
    """Run Path A, evaluate result, optionally escalate to Path B. Never raises."""

    # ── No website → try to find one, then fall back to Tavily ──────────────
    if not venue.website:
        found = website_finder.find(venue)
        if found:
            venue = replace(venue, website=found)
        else:
            return _tavily_fallback(venue)

    # ── Path A ────────────────────────────────────────────────────────────────
    fast_result = fast_scraper.scrape(venue)   # already has 30 s internal timeout
    n_fast = len(fast_result.events)

    # ── Routing decision ──────────────────────────────────────────────────────
    if n_fast >= 3:
        return fast_result                     # good enough, done

    # Pre-fetch homepage once so Path B doesn't pay for it again
    homepage = _fetch_homepage(venue)

    if n_fast == 0:
        # Escalate immediately
        thorough_result = _run_thorough(venue, homepage)
        thorough_result.scrape_strategy = "fast+escalated"
        return thorough_result

    # n_fast in [1, 2]: run Path B and take the richer result
    thorough_result = _run_thorough(venue, homepage)
    if len(thorough_result.events) > n_fast:
        thorough_result.scrape_strategy = "fast+escalated"
        return thorough_result

    return fast_result   # Path A was already better


# ── Helpers ───────────────────────────────────────────────────────────────────


def _run_thorough(venue: Venue, homepage: str) -> ScrapeResult:
    """Run Path B with a 90 s total timeout."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(thorough_scraper.scrape, venue, homepage)
        try:
            return future.result(timeout=_THOROUGH_TIMEOUT_S)
        except FuturesTimeout:
            future.cancel()
            return ScrapeResult(
                venue_id=venue.id,
                success=False,
                error="thorough path timeout",
                scrape_strategy="thorough",
            )
        except Exception as exc:
            return ScrapeResult(
                venue_id=venue.id,
                success=False,
                error=str(exc),
                scrape_strategy="thorough",
            )


def _fetch_homepage(venue: Venue) -> str:
    if not venue.website:
        return ""
    try:
        return fetch_page.invoke({"url": venue.website})
    except Exception:
        return ""
