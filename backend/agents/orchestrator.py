"""
M09 — Pipeline Orchestrator (Direction B)
Real LangGraph StateGraph: city_resolver → venue_discovery → [Send × N] scrape_venue → judge → knowledge_graph.
Parallel fan-out via Send API; scrape_results merged by operator.add reducer.
Progress events emitted to a thread-safe SimpleQueue and drained by the async generator.

Public interface:
    start_run(city_query, radius_km, concurrency=8) -> AsyncGenerator[dict, None]
    stop_run(run_id) -> None
    is_running() -> bool
"""

from __future__ import annotations

import asyncio
import operator
import queue
import threading
import uuid
from datetime import datetime
from typing import Annotated, AsyncGenerator, Optional

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from typing_extensions import TypedDict

import agents.city_resolver as city_resolver
import agents.judge_agent as judge_agent
import agents.knowledge_graph as knowledge_graph
import agents.venue_discovery as venue_discovery
import data.database as db
from agents.scrape_router import route as scraper_route
from models.types import CityInfo, JudgedEvent, RawEvent, RunStats, ScrapeResult, Venue


# ── State schema ───────────────────────────────────────────────────────────────


class PipelineState(TypedDict, total=False):
    run_id: str
    city_query: str
    radius_km: float
    amenity_types: list[str]
    venue_ids: Optional[list[str]]
    city_info: Optional[CityInfo]
    venues: list[Venue]
    scrape_results: Annotated[list[ScrapeResult], operator.add]  # reducer merges parallel results
    judged_events: list[JudgedEvent]


# ── Progress events (thread-safe) ─────────────────────────────────────────────

# SimpleQueue is thread-safe; scrape_venue_node writes from thread pool, generator reads from async loop.
_progress_queue: queue.SimpleQueue = queue.SimpleQueue()

# Stop signal (threading.Event so scrape_venue_node can check it from threads)
_stop_event: threading.Event = threading.Event()


# ── Node functions ─────────────────────────────────────────────────────────────


def city_resolver_node(state: PipelineState) -> dict:
    city_info: CityInfo = city_resolver.resolve(state["city_query"])
    return {"city_info": city_info}


def venue_discovery_node(state: PipelineState) -> dict:
    types = state.get("amenity_types") or ["library", "museum", "gallery", "arts_centre"]
    venues: list[Venue] = venue_discovery.discover(state["city_info"], state["radius_km"], types)
    for venue in venues:
        try:
            db.upsert_venue(venue)
        except Exception:
            pass
    return {"venues": venues}


def _fan_out(state: PipelineState) -> list[Send]:
    """Conditional edge: one Send per venue → parallel scrape_venue_node invocations."""
    venues = state.get("venues", [])
    venue_ids = state.get("venue_ids")
    if venue_ids:
        allowed = set(venue_ids)
        venues = [v for v in venues if v.id in allowed]
    return [
        Send("scrape_venue_node", {"venue": v, "city_info": state["city_info"]})
        for v in venues
    ]


def scrape_venue_node(state: dict) -> dict:
    """Runs once per venue (in LangGraph thread pool). Never raises — always returns ScrapeResult."""
    venue: Venue = state["venue"]

    if _stop_event.is_set():
        return {"scrape_results": [ScrapeResult(venue_id=venue.id, success=False, error="stopped")]}

    _progress_queue.put_nowait({
        "phase": "venue_start",
        "venue_id": venue.id,
        "venue_name": venue.name,
    })

    try:
        result: ScrapeResult = scraper_route(venue)
        try:
            status = "scraped" if result.success else "no_events"
            db.update_venue_scrape_status(venue.id, status, float(len(result.events)))
        except Exception:
            pass
        _progress_queue.put_nowait({
            "phase": "venue_done",
            "venue_id": venue.id,
            "venue_name": venue.name,
            "events_found": len(result.events),
            "strategy": result.strategy_used,
        })
        return {"scrape_results": [result]}
    except Exception as exc:
        err = str(exc)
        _progress_queue.put_nowait({
            "phase": "venue_error",
            "venue_id": venue.id,
            "venue_name": venue.name,
            "error": err,
        })
        return {"scrape_results": [ScrapeResult(venue_id=venue.id, success=False, error=err)]}


def judge_node(state: PipelineState) -> dict:
    all_events: list[RawEvent] = [e for r in state.get("scrape_results", []) for e in r.events]
    city_name: str = state["city_info"].name
    judged: list[JudgedEvent] = judge_agent.judge(all_events, city_name)
    return {"judged_events": judged}


def knowledge_graph_node(state: PipelineState) -> dict:
    import traceback as _tb
    city_name: str = state["city_info"].name
    try:
        knowledge_graph.update(city_name, state.get("judged_events") or [])
    except Exception:
        _tb.print_exc()
    return {}


# ── Graph build & compile ──────────────────────────────────────────────────────


def _build_graph():
    g: StateGraph = StateGraph(PipelineState)
    g.add_node("city_resolver_node", city_resolver_node)
    g.add_node("venue_discovery_node", venue_discovery_node)
    g.add_node("scrape_venue_node", scrape_venue_node)
    g.add_node("judge_node", judge_node)
    g.add_node("knowledge_graph_node", knowledge_graph_node)

    g.add_edge(START, "city_resolver_node")
    g.add_edge("city_resolver_node", "venue_discovery_node")
    g.add_conditional_edges("venue_discovery_node", _fan_out, ["scrape_venue_node"])
    g.add_edge("scrape_venue_node", "judge_node")
    g.add_edge("judge_node", "knowledge_graph_node")
    g.add_edge("knowledge_graph_node", END)
    return g.compile()


graph = _build_graph()

__all__ = ["graph"]


# ── Run state ──────────────────────────────────────────────────────────────────


_running: bool = False
_current_run_id: Optional[str] = None


def is_running() -> bool:
    return _running


def stop_run(run_id: str) -> None:
    if run_id == _current_run_id:
        _stop_event.set()


# ── Main generator ─────────────────────────────────────────────────────────────


async def start_run(
    city_query: str,
    radius_km: float,
    concurrency: int = 8,
    amenity_types: list[str] | None = None,
    venue_ids: list[str] | None = None,
) -> AsyncGenerator[dict, None]:
    """Runs the full pipeline via LangGraph astream, yielding SSE-compatible progress dicts."""
    global _running, _current_run_id

    _running = True
    _stop_event.clear()
    # Drain any leftover events from a previous run
    while not _progress_queue.empty():
        _progress_queue.get_nowait()

    run_id = str(uuid.uuid4())
    _current_run_id = run_id
    started_at = datetime.utcnow()

    try:
        db.insert_run(run_id, city_query, radius_km, started_at)
    except Exception:
        pass

    yield {"phase": "run_start", "run_id": run_id, "city": city_query}

    initial_state: PipelineState = {
        "run_id": run_id,
        "city_query": city_query,
        "radius_km": radius_km,
        "amenity_types": amenity_types or ["library", "museum", "gallery", "arts_centre"],
        "venue_ids": venue_ids or None,
        "scrape_results": [],
    }

    # Accumulated full state (astream "updates" only gives deltas)
    acc: dict = {**initial_state}

    try:
        async for chunk in graph.astream(
            initial_state,
            config={"max_concurrency": concurrency},
            stream_mode="updates",
        ):
            # Drain progress queue before processing each chunk
            while not _progress_queue.empty():
                yield _progress_queue.get_nowait()

            for node_name, delta in chunk.items():
                if not isinstance(delta, dict):
                    continue
                # Merge delta into accumulated state (reducer-aware for scrape_results)
                if "scrape_results" in delta:
                    acc["scrape_results"] = acc.get("scrape_results", []) + delta["scrape_results"]
                acc.update({k: v for k, v in delta.items() if k != "scrape_results"})

                # Translate node completion → SSE event
                if node_name == "venue_discovery_node":
                    venues: list[Venue] = delta.get("venues", [])
                    with_website = sum(1 for v in venues if v.website)
                    yield {
                        "phase": "discovery_done",
                        "venues_total": len(venues),
                        "venues_with_website": with_website,
                    }

                elif node_name == "judge_node":
                    judged: list[JudgedEvent] = delta.get("judged_events", [])
                    all_events = [e for r in acc["scrape_results"] for e in r.events]
                    accepted = sum(1 for e in judged if e.verdict == "accept")
                    review_cnt = sum(1 for e in judged if e.verdict == "review")
                    rejected = sum(1 for e in judged if e.verdict == "reject")
                    yield {"phase": "judging_start", "events_raw": len(all_events)}
                    yield {
                        "phase": "judging_done",
                        "events_accepted": accepted,
                        "events_review": review_cnt,
                        "events_rejected": rejected,
                    }

                elif node_name == "knowledge_graph_node":
                    city_info: Optional[CityInfo] = acc.get("city_info")
                    judged_all: list[JudgedEvent] = acc.get("judged_events", [])
                    city_name = city_info.name if city_info else city_query
                    sim_pairs = db.count_kg_similarity(city_name)
                    tagged_venues = len({e.venue_id for e in judged_all if e.verdict == "accept"})
                    yield {
                        "phase": "kg_done",
                        "tagged_venues": tagged_venues,
                        "similarity_pairs": sim_pairs,
                    }

        # Drain any remaining progress events after astream completes
        while not _progress_queue.empty():
            yield _progress_queue.get_nowait()

        # Emit run_done
        city_info = acc.get("city_info")
        venues_list: list[Venue] = acc.get("venues", [])
        scrape_results: list[ScrapeResult] = acc.get("scrape_results", [])
        judged_final: list[JudgedEvent] = acc.get("judged_events", [])
        all_events_final = [e for r in scrape_results for e in r.events]
        accepted_final = sum(1 for e in judged_final if e.verdict == "accept")
        finished_at = datetime.utcnow()
        venues_failed = sum(1 for r in scrape_results if not r.success)

        stats = RunStats(
            run_id=run_id,
            city=city_info.display if city_info else city_query,
            venues_total=len(venues_list),
            venues_done=len(scrape_results),
            venues_failed=venues_failed,
            events_found=len(all_events_final),
            events_accepted=accepted_final,
            started_at=started_at,
            finished_at=finished_at,
        )
        try:
            db.finish_run(run_id, finished_at, _stats_to_dict(stats))
        except Exception:
            pass

        yield {"phase": "run_done", **_stats_to_dict(stats)}

    except Exception as exc:
        yield {"phase": "run_error", "error": str(exc)}

    finally:
        _running = False
        _current_run_id = None


# ── Helpers ────────────────────────────────────────────────────────────────────


def _stats_to_dict(stats: RunStats) -> dict:
    return {
        "run_id": stats.run_id,
        "city": stats.city,
        "venues_total": stats.venues_total,
        "venues_done": stats.venues_done,
        "venues_failed": stats.venues_failed,
        "events_found": stats.events_found,
        "events_accepted": stats.events_accepted,
        "started_at": stats.started_at.isoformat() if stats.started_at else None,
        "finished_at": stats.finished_at.isoformat() if stats.finished_at else None,
    }
