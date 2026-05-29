"""
M06 — Venue Processor
Fan-out scraping across all venues in parallel with a semaphore concurrency cap.
Emits ProgressEvents via callback. Soft-stop: pending venues skipped, in-flight complete.

Public interface:
    process_all(venues, concurrency, on_progress) -> list[ScrapeResult]
    stop() -> None
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable, Optional

from agents.scraper_agent import scrape
from models.types import ScrapeResult, Venue


@dataclass
class ProgressEvent:
    phase: str          # venue_start | venue_done | venue_error
    venue_id: str
    venue_name: str
    events_found: Optional[int] = None
    strategy_used: Optional[str] = None
    error: Optional[str] = None


_stop_event: Optional[asyncio.Event] = None


async def process_all(
    venues: list[Venue],
    concurrency: int,
    on_progress: Callable[[ProgressEvent], None],
) -> list[ScrapeResult]:
    """Process all venues with up to `concurrency` parallel scrapes. Returns all results."""
    global _stop_event
    _stop_event = asyncio.Event()
    sem = asyncio.Semaphore(concurrency)

    async def _run_one(venue: Venue) -> Optional[ScrapeResult]:
        if _stop_event.is_set():
            return None
        async with sem:
            if _stop_event.is_set():
                return None
            on_progress(ProgressEvent(phase="venue_start", venue_id=venue.id, venue_name=venue.name))
            try:
                loop = asyncio.get_running_loop()
                result: ScrapeResult = await loop.run_in_executor(None, scrape, venue)
                on_progress(ProgressEvent(
                    phase="venue_done",
                    venue_id=venue.id,
                    venue_name=venue.name,
                    events_found=len(result.events),
                    strategy_used=result.strategy_used,
                ))
                return result
            except Exception as exc:
                err = str(exc)
                on_progress(ProgressEvent(
                    phase="venue_error",
                    venue_id=venue.id,
                    venue_name=venue.name,
                    error=err,
                ))
                return ScrapeResult(venue_id=venue.id, success=False, error=err)

    tasks = [asyncio.create_task(_run_one(v)) for v in venues]
    raw = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in raw if isinstance(r, ScrapeResult)]


def stop() -> None:
    """Signal process_all to skip any venues not yet started."""
    global _stop_event
    if _stop_event is not None:
        _stop_event.set()
