"""
M10 — API Layer
All FastAPI route definitions. Forwards SSE events from orchestrator to browser.

Pipeline runs as an independent asyncio.Task (decoupled from SSE connection).
Clients can reconnect after a page refresh and receive buffered + live events.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

import agents.orchestrator as orchestrator
import data.database as db
from api.schemas import RunRequest

router = APIRouter()

# ── Pending-run store (run_id → params, before SSE connects) ─────────────────
_pending_runs: dict[str, dict] = {}

# ── Active run state (run_id → {queue, task, done}) ──────────────────────────
# Each run gets a per-run asyncio.Queue so multiple SSE reconnects can drain it.
# Events are also buffered in _run_events so a reconnecting client gets history.
_active_runs: dict[str, dict] = {}   # run_id → {queue, task, done, events}


# ── Run lifecycle ──────────────────────────────────────────────────────────────


@router.post("/api/run")
async def create_run(request: RunRequest):
    if orchestrator.is_running():
        raise HTTPException(
            status_code=409,
            detail={"error": "A run is already in progress", "code": "ALREADY_RUNNING"},
        )
    run_id = str(uuid.uuid4())
    _pending_runs[run_id] = {
        "city": request.city,
        "radius_km": request.radius_km,
        "amenity_types": request.valid_amenity_types,
        "venue_ids": request.venue_ids,
    }
    return {"run_id": run_id}


async def _pipeline_task(run_id: str, params: dict):
    """Runs the full pipeline independently of any HTTP connection."""
    q: asyncio.Queue = _active_runs[run_id]["queue"]
    try:
        async for event in orchestrator.start_run(
            params["city"],
            params["radius_km"],
            amenity_types=params["amenity_types"],
            venue_ids=params.get("venue_ids"),
        ):
            _active_runs[run_id]["events"].append(event)
            await q.put(event)
            if event.get("phase") in ("run_done", "run_error"):
                break
    finally:
        _active_runs[run_id]["done"] = True
        await q.put(None)  # sentinel: tells SSE readers to stop


@router.get("/api/run/{run_id}/stream")
async def stream_run(run_id: str):
    # First connection: start the pipeline task
    if run_id in _pending_runs:
        params = _pending_runs.pop(run_id)
        q: asyncio.Queue = asyncio.Queue()
        _active_runs[run_id] = {"queue": q, "task": None, "done": False, "events": []}
        task = asyncio.create_task(_pipeline_task(run_id, params))
        _active_runs[run_id]["task"] = task

    # Reconnection after page refresh: replay buffered events then stream live
    elif run_id in _active_runs:
        pass  # handled below
    else:
        raise HTTPException(status_code=404, detail={"error": "Run not found", "code": "NOT_FOUND"})

    state = _active_runs[run_id]

    async def event_stream():
        # Replay already-received events for reconnecting clients
        for event in list(state["events"]):
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("phase") in ("run_done", "run_error"):
                return

        # Stream live events
        if state["done"]:
            return
        q: asyncio.Queue = state["queue"]
        while True:
            event = await q.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("phase") in ("run_done", "run_error"):
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.delete("/api/run/{run_id}")
async def stop_run(run_id: str):
    orchestrator.stop_run(run_id)
    if run_id in _active_runs:
        _active_runs[run_id]["done"] = True
    return {"stopped": True}


@router.get("/api/run/{run_id}/status")
async def get_run_status(run_id: str):
    still_running = run_id in _active_runs and not _active_runs[run_id]["done"]
    run = db.get_run(run_id)
    if run is None and not still_running:
        raise HTTPException(status_code=404, detail={"error": "Run not found"})
    finished = run["finished_at"] is not None if run else False
    stats = json.loads(run["stats"]) if run and run["stats"] else None
    city = run["city"] if run else None
    return {
        "run_id": run_id,
        "city": city,
        "finished": finished,
        "still_running": still_running,
        "started_at": run["started_at"] if run else None,
        "finished_at": run["finished_at"] if run else None,
        "stats": stats,
    }


# ── Data endpoints ─────────────────────────────────────────────────────────────


@router.get("/api/venues")
async def get_venues(
    city: Optional[str] = None,
    type: Optional[list[str]] = Query(default=None),
    has_website: Optional[bool] = None,
    status: Optional[str] = None,
    limit: int = 200,
):
    venues = db.get_venues(city=city, types=type, has_website=has_website, status=status, limit=limit)
    return {"venues": venues}


@router.get("/api/events")
async def get_events(
    city: Optional[str] = None,
    verdict: Optional[list[str]] = Query(default=None),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    venue_type: Optional[str] = None,
    limit: int = 200,
):
    events = db.get_events(
        city=city,
        verdicts=verdict,
        date_from=date_from,
        date_to=date_to,
        venue_type=venue_type,
        limit=limit,
    )
    return {"events": events}


# ── Knowledge-graph endpoints ──────────────────────────────────────────────────


@router.get("/api/graph/tags")
async def get_graph_tags(city: Optional[str] = None):
    tags = db.get_kg_tags(city)
    return {"tags": tags}


@router.get("/api/graph/search")
async def search_graph(
    city: Optional[str] = None,
    tag: Optional[str] = None,
    entity: Optional[str] = None,
    limit: int = 40,
):
    if tag:
        venues = db.get_venues_by_tag(city=city, tag=tag, limit=limit)
    elif entity:
        venues = db.get_venues_by_entity(city=city, entity=entity, limit=limit)
    else:
        venues = []
    return {"venues": venues}


@router.get("/api/graph/venue/{venue_id}")
async def get_graph_venue(venue_id: str):
    venue = db.get_venue(venue_id)
    if venue is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "Venue not found", "code": "NOT_FOUND"},
        )
    tags = db.get_kg_tags_for_venue(venue_id)
    similar = db.get_kg_similarity_for_venue(venue_id)
    entities = db.get_kg_entities_for_venue(venue_id)
    return {"venue": venue, "tags": tags, "similar": similar, "entities": entities}


# ── Pipeline diagram ──────────────────────────────────────────────────────────


@router.get("/api/pipeline/diagram")
async def pipeline_diagram():
    from fastapi.responses import Response
    import agents.orchestrator as orch
    png = orch.graph.get_graph().draw_mermaid_png()
    return Response(content=png, media_type="image/png")


# ── Health ─────────────────────────────────────────────────────────────────────


@router.get("/api/runs")
async def list_runs():
    runs = db.get_all_finished_runs()
    return {"runs": runs}


@router.get("/api/runs/latest")
async def latest_run():
    run = db.get_latest_finished_run()
    if run is None:
        return {"run": None}
    return {"run": {"run_id": run["run_id"], "city": run["city"], "finished_at": run["finished_at"]}}


@router.get("/api/health")
async def health():
    return {"status": "ok", "db": "ok"}
