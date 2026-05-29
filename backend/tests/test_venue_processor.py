"""Tests for M06 — Venue Processor. M05 scrape() is mocked; asyncio fan-out tested."""

import asyncio
import threading
import time
from unittest.mock import patch

import pytest

from agents.venue_processor import ProgressEvent, process_all, stop
from models.types import ScrapeResult, Venue


def _venue(i: int) -> Venue:
    return Venue(
        id=f"v{i}",
        name=f"Venue {i}",
        type="museum",
        city="Austin",
        country="US",
        lat=30.0,
        lon=-97.0,
        osm_id=str(i),
    )


def _ok_result(venue_id: str) -> ScrapeResult:
    return ScrapeResult(venue_id=venue_id, success=True, events=[], strategy_used="ical", attempts=1)


# ── Basic behaviour ────────────────────────────────────────────────────────────


async def test_process_all_returns_all_results():
    venues = [_venue(1), _venue(2)]

    def mock_scrape(v):
        return _ok_result(v.id)

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        results = await process_all(venues, concurrency=2, on_progress=lambda e: None)

    assert len(results) == 2
    assert all(isinstance(r, ScrapeResult) for r in results)


async def test_empty_venues_returns_empty():
    results = await process_all([], concurrency=2, on_progress=lambda e: None)
    assert results == []


async def test_progress_events_emitted():
    venues = [_venue(1)]
    events: list[ProgressEvent] = []

    def mock_scrape(v):
        return _ok_result(v.id)

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        await process_all(venues, concurrency=1, on_progress=events.append)

    phases = [e.phase for e in events]
    assert "venue_start" in phases
    assert "venue_done" in phases


async def test_venue_done_carries_event_count():
    venues = [_venue(1)]
    events: list[ProgressEvent] = []

    def mock_scrape(v):
        return ScrapeResult(venue_id=v.id, success=True, events=[], strategy_used="ical", attempts=1)

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        await process_all(venues, concurrency=1, on_progress=events.append)

    done = next(e for e in events if e.phase == "venue_done")
    assert done.events_found == 0
    assert done.strategy_used == "ical"


# ── Error isolation ────────────────────────────────────────────────────────────


async def test_failed_scrape_emits_venue_error():
    venues = [_venue(1), _venue(2)]
    events: list[ProgressEvent] = []

    call_count = [0]

    def mock_scrape(v):
        call_count[0] += 1
        if call_count[0] == 1:
            raise RuntimeError("network timeout")
        return _ok_result(v.id)

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        results = await process_all(venues, concurrency=2, on_progress=events.append)

    error_events = [e for e in events if e.phase == "venue_error"]
    assert len(error_events) == 1
    assert "network timeout" in error_events[0].error


async def test_failed_venue_does_not_block_others():
    venues = [_venue(1), _venue(2), _venue(3)]
    succeeded: list[str] = []

    def mock_scrape(v):
        if v.id == "v1":
            raise RuntimeError("boom")
        succeeded.append(v.id)
        return _ok_result(v.id)

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        results = await process_all(venues, concurrency=3, on_progress=lambda e: None)

    # All 3 venues have results — failures return ScrapeResult(success=False)
    assert len(results) == 3
    assert set(succeeded) == {"v2", "v3"}
    failed = [r for r in results if not r.success]
    assert len(failed) == 1
    assert failed[0].venue_id == "v1"


# ── Concurrency cap ────────────────────────────────────────────────────────────


async def test_concurrency_cap_respected():
    concurrent = [0]
    max_concurrent = [0]
    lock = threading.Lock()

    def mock_scrape(v):
        with lock:
            concurrent[0] += 1
            max_concurrent[0] = max(max_concurrent[0], concurrent[0])
        time.sleep(0.04)
        with lock:
            concurrent[0] -= 1
        return _ok_result(v.id)

    venues = [_venue(i) for i in range(6)]
    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        await process_all(venues, concurrency=2, on_progress=lambda e: None)

    assert max_concurrent[0] <= 2


# ── stop() ─────────────────────────────────────────────────────────────────────


async def test_stop_skips_pending_venues():
    venues = [_venue(i) for i in range(5)]
    first_started = threading.Event()

    def mock_scrape(v):
        first_started.set()
        time.sleep(0.06)
        return _ok_result(v.id)

    async def stopper():
        while not first_started.is_set():
            await asyncio.sleep(0.005)
        stop()

    with patch("agents.venue_processor.scrape", side_effect=mock_scrape):
        gather_results = await asyncio.gather(
            process_all(venues, concurrency=1, on_progress=lambda e: None),
            stopper(),
        )

    results = gather_results[0]
    # With concurrency=1 and stop() fired after first starts, < 5 venues should complete
    assert len(results) < 5
