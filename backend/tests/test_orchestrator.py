"""Tests for M09 — Orchestrator. All agent modules and DB are mocked."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import agents.orchestrator as orchestrator
from agents.venue_processor import ProgressEvent
from models.types import CityInfo, JudgedEvent, RawEvent, ScrapeResult, Venue

CITY = CityInfo(
    name="Austin",
    country="US",
    lat=30.27,
    lon=-97.74,
    display="Austin, Texas, United States",
    state="Texas",
)
VENUE = Venue(id="v1", name="Venue 1", type="museum", city="Austin", country="US", lat=30.0, lon=-97.0, osm_id="1")
RAW = RawEvent(title="Jazz Night", date="2026-06-01", venue_id="v1", source_strategy="ical")
JUDGED = JudgedEvent(
    title="Jazz Night",
    date="2026-06-01",
    venue_id="v1",
    source_strategy="ical",
    quality_score=0.8,
    verdict="accept",
    judged_at=datetime.utcnow(),
)


@pytest.fixture(autouse=True)
def reset_state():
    orchestrator._running = False
    orchestrator._current_run_id = None
    yield
    orchestrator._running = False
    orchestrator._current_run_id = None


@pytest.fixture
def mocks():
    """Patch all agent modules and DB used by orchestrator."""
    with (
        patch("agents.orchestrator.city_resolver") as mock_cr,
        patch("agents.orchestrator.venue_discovery") as mock_vd,
        patch("agents.orchestrator.venue_processor") as mock_vp,
        patch("agents.orchestrator.judge_agent") as mock_ja,
        patch("agents.orchestrator.knowledge_graph") as mock_kg,
        patch("agents.orchestrator.db") as mock_db,
    ):
        mock_cr.resolve.return_value = CITY
        mock_vd.discover.return_value = [VENUE]
        mock_vp.process_all = AsyncMock(return_value=[
            ScrapeResult(venue_id="v1", success=True, events=[RAW], strategy_used="ical", attempts=1)
        ])
        mock_vp.stop = MagicMock()
        mock_ja.judge.return_value = [JUDGED]
        mock_kg.update.return_value = None
        mock_db.insert_run.return_value = None
        mock_db.finish_run.return_value = None
        mock_db.count_kg_similarity.return_value = 1
        yield {
            "city_resolver": mock_cr,
            "venue_discovery": mock_vd,
            "venue_processor": mock_vp,
            "judge_agent": mock_ja,
            "knowledge_graph": mock_kg,
        }


async def _collect(gen) -> list[dict]:
    return [event async for event in gen]


# ── is_running / basic lifecycle ───────────────────────────────────────────────


async def test_is_running_false_initially():
    assert not orchestrator.is_running()


async def test_is_running_true_after_first_yield(mocks):
    gen = orchestrator.start_run("Austin", 30.0)
    await gen.__anext__()  # run_start — _running is now True
    assert orchestrator.is_running()
    async for _ in gen:
        pass
    assert not orchestrator.is_running()


async def test_first_event_is_run_start(mocks):
    gen = orchestrator.start_run("Austin", 30.0)
    first = await gen.__anext__()
    assert first["phase"] == "run_start"
    assert "run_id" in first
    assert first["city"] == "Austin"
    async for _ in gen:
        pass


async def test_all_expected_phases_emitted(mocks):
    events = await _collect(orchestrator.start_run("Austin", 30.0))
    phases = [e["phase"] for e in events]
    assert phases[0] == "run_start"
    assert "discovery_done" in phases
    assert "judging_start" in phases
    assert "judging_done" in phases
    assert "kg_done" in phases
    assert phases[-1] == "run_done"


async def test_run_done_carries_stats(mocks):
    events = await _collect(orchestrator.start_run("Austin", 30.0))
    run_done = next(e for e in events if e["phase"] == "run_done")
    assert "venues_total" in run_done
    assert "events_accepted" in run_done
    assert "run_id" in run_done


async def test_is_running_false_after_run_done(mocks):
    await _collect(orchestrator.start_run("Austin", 30.0))
    assert not orchestrator.is_running()


# ── Error handling ─────────────────────────────────────────────────────────────


async def test_city_resolver_error_emits_run_error():
    with (
        patch("agents.orchestrator.city_resolver") as mock_cr,
        patch("agents.orchestrator.db") as mock_db,
    ):
        mock_cr.resolve.side_effect = Exception("not found")
        mock_db.insert_run.return_value = None

        events = await _collect(orchestrator.start_run("BadCity", 30.0))

    phases = [e["phase"] for e in events]
    assert "run_start" in phases
    assert "run_error" in phases
    assert "run_done" not in phases


async def test_is_running_false_after_run_error():
    with (
        patch("agents.orchestrator.city_resolver") as mock_cr,
        patch("agents.orchestrator.db") as mock_db,
    ):
        mock_cr.resolve.side_effect = Exception("boom")
        mock_db.insert_run.return_value = None
        await _collect(orchestrator.start_run("Nowhere", 30.0))
    assert not orchestrator.is_running()


# ── stop_run ───────────────────────────────────────────────────────────────────


async def test_stop_run_calls_venue_processor_stop(mocks):
    gen = orchestrator.start_run("Austin", 30.0)
    first = await gen.__anext__()
    run_id = first["run_id"]

    orchestrator.stop_run(run_id)
    mocks["venue_processor"].stop.assert_called_once()

    async for _ in gen:
        pass


async def test_stop_run_wrong_id_does_not_stop(mocks):
    gen = orchestrator.start_run("Austin", 30.0)
    await gen.__anext__()

    orchestrator.stop_run("wrong-id")
    mocks["venue_processor"].stop.assert_not_called()

    async for _ in gen:
        pass


# ── discovery_done carries counts ─────────────────────────────────────────────


async def test_discovery_done_venue_count(mocks):
    events = await _collect(orchestrator.start_run("Austin", 30.0))
    disc = next(e for e in events if e["phase"] == "discovery_done")
    assert disc["venues_total"] == 1


# ── judging counts ─────────────────────────────────────────────────────────────


async def test_judging_done_accepted_count(mocks):
    events = await _collect(orchestrator.start_run("Austin", 30.0))
    jdone = next(e for e in events if e["phase"] == "judging_done")
    assert jdone["events_accepted"] == 1
    assert jdone["events_review"] == 0
    assert jdone["events_rejected"] == 0
