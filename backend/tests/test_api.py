"""Tests for M10 — API Layer. Uses FastAPI TestClient; orchestrator and DB are mocked."""

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import agents.orchestrator as orchestrator
from api import routes
from main import app

client = TestClient(app)


# ── Test isolation fixtures ────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def reset_state():
    routes._pending_runs.clear()
    orchestrator._running = False
    orchestrator._current_run_id = None
    yield
    routes._pending_runs.clear()
    orchestrator._running = False
    orchestrator._current_run_id = None


# ── Mock generator factory ─────────────────────────────────────────────────────


async def _gen(*events):
    for e in events:
        yield e


def _make_gen():
    return _gen(
        {"phase": "run_start", "run_id": "test-run-id", "city": "Austin"},
        {"phase": "discovery_done", "venues_total": 1, "venues_with_website": 1},
        {"phase": "run_done", "run_id": "test-run-id", "events_accepted": 0},
    )


# ── Health ─────────────────────────────────────────────────────────────────────


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "db": "ok"}


# ── POST /api/run validation ───────────────────────────────────────────────────


def test_post_run_rejects_empty_city():
    resp = client.post("/api/run", json={"city": "", "radius_km": 30})
    assert resp.status_code == 422


def test_post_run_rejects_radius_too_small():
    resp = client.post("/api/run", json={"city": "Austin", "radius_km": 1})
    assert resp.status_code == 422


def test_post_run_rejects_radius_too_large():
    resp = client.post("/api/run", json={"city": "Austin", "radius_km": 999})
    assert resp.status_code == 422


def test_post_run_rejects_missing_city():
    resp = client.post("/api/run", json={"radius_km": 30})
    assert resp.status_code == 422


def test_post_run_returns_run_id():
    with patch("agents.orchestrator.is_running", return_value=False):
        resp = client.post("/api/run", json={"city": "Austin", "radius_km": 30})
    assert resp.status_code == 200
    assert "run_id" in resp.json()
    assert resp.json()["run_id"]  # non-empty


def test_post_run_409_when_already_running():
    with patch("agents.orchestrator.is_running", return_value=True):
        resp = client.post("/api/run", json={"city": "Austin", "radius_km": 30})
    assert resp.status_code == 409


def test_post_run_default_radius_stored():
    """POST stores radius_km=30.0 default; SSE passes it to start_run."""
    with patch("agents.orchestrator.is_running", return_value=False):
        post = client.post("/api/run", json={"city": "Austin"})
    assert post.status_code == 200
    run_id = post.json()["run_id"]

    with patch("agents.orchestrator.start_run", side_effect=lambda *a, **k: _make_gen()) as mock_start:
        client.get(f"/api/run/{run_id}/stream")
    mock_start.assert_called_once_with("Austin", 30.0)


# ── GET /api/run/{run_id}/stream ───────────────────────────────────────────────


def test_stream_404_for_unknown_run():
    resp = client.get("/api/run/no-such-id/stream")
    assert resp.status_code == 404


def test_stream_delivers_events():
    with patch("agents.orchestrator.is_running", return_value=False):
        post = client.post("/api/run", json={"city": "Austin", "radius_km": 30})
    assert post.status_code == 200
    run_id = post.json()["run_id"]

    # side_effect creates the generator inside the GET handler's context
    with patch("agents.orchestrator.start_run", side_effect=lambda *a, **k: _make_gen()):
        resp = client.get(f"/api/run/{run_id}/stream")

    assert resp.status_code == 200
    data_lines = [l for l in resp.text.split("\n") if l.startswith("data:")]
    assert len(data_lines) >= 3  # run_start, discovery_done, run_done
    first_payload = json.loads(data_lines[0][len("data: "):])
    assert first_payload["phase"] == "run_start"


def test_stream_last_event_is_run_done():
    with patch("agents.orchestrator.is_running", return_value=False):
        post = client.post("/api/run", json={"city": "Austin", "radius_km": 30})
    run_id = post.json()["run_id"]

    with patch("agents.orchestrator.start_run", side_effect=lambda *a, **k: _make_gen()):
        resp = client.get(f"/api/run/{run_id}/stream")

    data_lines = [l for l in resp.text.split("\n") if l.startswith("data:")]
    last_payload = json.loads(data_lines[-1][len("data: "):])
    assert last_payload["phase"] == "run_done"


def test_stream_consumed_once():
    with patch("agents.orchestrator.is_running", return_value=False):
        post = client.post("/api/run", json={"city": "Austin", "radius_km": 30})
    run_id = post.json()["run_id"]

    with patch("agents.orchestrator.start_run", side_effect=lambda *a, **k: _make_gen()):
        client.get(f"/api/run/{run_id}/stream")

    # second GET → 404 because params were popped from _pending_runs
    resp2 = client.get(f"/api/run/{run_id}/stream")
    assert resp2.status_code == 404


# ── DELETE /api/run/{run_id} ───────────────────────────────────────────────────


def test_delete_run():
    with patch("agents.orchestrator.stop_run") as mock_stop:
        resp = client.delete("/api/run/some-run-id")
    assert resp.status_code == 200
    assert resp.json()["stopped"] is True
    mock_stop.assert_called_once_with("some-run-id")


# ── GET /api/venues ────────────────────────────────────────────────────────────


def test_get_venues_returns_list():
    with patch("data.database.get_venues", return_value=[]):
        resp = client.get("/api/venues?city=Austin")
    assert resp.status_code == 200
    assert resp.json() == {"venues": []}


def test_get_venues_passes_params():
    with patch("data.database.get_venues", return_value=[]) as mock_get:
        client.get("/api/venues?city=Austin&type=museum&has_website=true&limit=10")
    mock_get.assert_called_once_with(
        city="Austin", types=["museum"], has_website=True, status=None, limit=10
    )


# ── GET /api/events ────────────────────────────────────────────────────────────


def test_get_events_returns_list():
    with patch("data.database.get_events", return_value=[]):
        resp = client.get("/api/events?city=Austin")
    assert resp.status_code == 200
    assert resp.json() == {"events": []}


# ── GET /api/graph/tags ────────────────────────────────────────────────────────


def test_get_graph_tags():
    tag_data = [{"tag": "jazz", "venue_count": 2, "avg_weight": 0.8}]
    with patch("data.database.get_kg_tags", return_value=tag_data):
        resp = client.get("/api/graph/tags?city=Austin")
    assert resp.status_code == 200
    assert len(resp.json()["tags"]) == 1
    assert resp.json()["tags"][0]["tag"] == "jazz"


# ── GET /api/graph/search ──────────────────────────────────────────────────────


def test_graph_search_by_tag():
    with patch("data.database.get_venues_by_tag", return_value=[]) as mock_fn:
        resp = client.get("/api/graph/search?city=Austin&tag=jazz&limit=10")
    assert resp.status_code == 200
    mock_fn.assert_called_once_with(city="Austin", tag="jazz", limit=10)


def test_graph_search_by_entity():
    with patch("data.database.get_venues_by_entity", return_value=[]) as mock_fn:
        resp = client.get("/api/graph/search?entity=Miles+Davis")
    assert resp.status_code == 200
    mock_fn.assert_called_once_with(city=None, entity="Miles Davis", limit=40)


def test_graph_search_no_params_returns_empty():
    resp = client.get("/api/graph/search")
    assert resp.status_code == 200
    assert resp.json() == {"venues": []}


# ── GET /api/graph/venue/{venue_id} ───────────────────────────────────────────


def test_graph_venue_returns_data():
    venue_row = {
        "id": "v1", "name": "Jazz Club", "type": "museum",
        "city": "Austin", "country": "US", "lat": 30.0, "lon": -97.0,
        "osm_id": "1", "address": None, "website": None,
        "last_osm_sync": None, "last_scraped_at": None,
        "scrape_status": "never_scraped", "avg_events": 0,
    }
    with patch("data.database.get_venue", return_value=venue_row), \
         patch("data.database.get_kg_tags_for_venue", return_value=[]), \
         patch("data.database.get_kg_similarity_for_venue", return_value=[]), \
         patch("data.database.get_kg_entities_for_venue", return_value=[]):
        resp = client.get("/api/graph/venue/v1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["venue"]["name"] == "Jazz Club"
    assert "tags" in data
    assert "similar" in data
    assert "entities" in data


def test_graph_venue_404():
    with patch("data.database.get_venue", return_value=None):
        resp = client.get("/api/graph/venue/nonexistent")
    assert resp.status_code == 404
