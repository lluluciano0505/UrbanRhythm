"""Tests for M08 — Knowledge Graph. LLM calls are mocked; DB uses in-memory SQLite."""

import json
import math
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

import data.database as db
from agents.knowledge_graph import (
    _compute_weights,
    _cosine_similarity,
    _normalize_tag,
    update,
)
from models.types import JudgedEvent, Venue

VENUES = [
    Venue(id=f"osm_node_{i}", name=f"Venue {i}", type="museum",
          city="Austin", country="US", lat=30.0 + i * 0.1, lon=-97.0, osm_id=str(i))
    for i in range(1, 4)
]


@pytest.fixture(autouse=True)
def fresh_db():
    db.init_db(":memory:")
    for v in VENUES:
        db.upsert_venue(v)


def _event(
    venue_id: str = "osm_node_1",
    title: str = "Jazz Night",
    description: str = None,
    verdict: str = "accept",
) -> JudgedEvent:
    return JudgedEvent(
        title=title,
        date="2026-06-01",
        venue_id=venue_id,
        source_strategy="ical",
        description=description,
        quality_score=0.8,
        verdict=verdict,
        judged_at=datetime.utcnow(),
    )


def _mock_llm(content: str):
    mock_llm = MagicMock()
    mock_llm.invoke.return_value = MagicMock(content=content)
    return mock_llm


def _simple_resp(tags: list[str], entities: list[dict] = None) -> str:
    return json.dumps({
        "event_tags": [{"event_idx": 0, "tags": tags}],
        "entities": entities or [],
    })


# ── _normalize_tag ────────────────────────────────────────────────────────────


def test_normalize_tag_lowercases():
    assert _normalize_tag("Jazz") == "jazz"


def test_normalize_tag_replaces_spaces():
    assert _normalize_tag("live music") == "live_music"


def test_normalize_tag_replaces_hyphens():
    assert _normalize_tag("contemporary-art") == "contemporary_art"


def test_normalize_tag_strips_leading_trailing_specials():
    assert _normalize_tag("  Jazz! ") == "jazz"


def test_normalize_tag_multiple_specials_collapsed():
    assert _normalize_tag("folk & jazz") == "folk_jazz"


# ── _compute_weights ──────────────────────────────────────────────────────────


def test_compute_weights_single_event_single_tag():
    weights = _compute_weights([["jazz"]], total_events=1)
    assert weights["jazz"] == pytest.approx(1.0)


def test_compute_weights_two_events_shared_tag():
    weights = _compute_weights([["jazz"], ["jazz", "blues"]], total_events=2)
    assert weights["jazz"] == pytest.approx(1.0)
    assert weights["blues"] == pytest.approx(0.5)


def test_compute_weights_empty_total():
    assert _compute_weights([], total_events=0) == {}


def test_compute_weights_tag_counted_once_per_event():
    weights = _compute_weights([["jazz", "jazz"]], total_events=2)
    assert weights["jazz"] == pytest.approx(0.5)


def test_compute_weights_excludes_empty_tag():
    weights = _compute_weights([["", "jazz"]], total_events=1)
    assert "" not in weights
    assert "jazz" in weights


# ── _cosine_similarity ────────────────────────────────────────────────────────


def test_cosine_similarity_identical_vectors():
    v = {"jazz": 0.8, "music": 0.6}
    assert _cosine_similarity(v, v) == pytest.approx(1.0)


def test_cosine_similarity_orthogonal_vectors():
    assert _cosine_similarity({"jazz": 1.0}, {"film": 1.0}) == pytest.approx(0.0)


def test_cosine_similarity_empty_vector_returns_zero():
    assert _cosine_similarity({}, {"jazz": 1.0}) == pytest.approx(0.0)
    assert _cosine_similarity({"jazz": 1.0}, {}) == pytest.approx(0.0)


def test_cosine_similarity_partial_overlap():
    a = {"jazz": 1.0, "music": 1.0}
    b = {"jazz": 1.0}
    # dot = 1, |a| = sqrt(2), |b| = 1 → 1/sqrt(2)
    assert _cosine_similarity(a, b) == pytest.approx(1 / math.sqrt(2), rel=1e-3)


# ── update() ─────────────────────────────────────────────────────────────────


def test_update_empty_events_no_llm_calls():
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        update("Austin", [])
        mock_cls.assert_not_called()


def test_update_all_non_accept_no_llm_calls():
    events = [_event(verdict="review"), _event(verdict="reject")]
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        update("Austin", events)
        mock_cls.assert_not_called()


def test_update_filters_non_accept():
    events = [
        _event(venue_id="osm_node_1", verdict="accept"),
        _event(venue_id="osm_node_1", verdict="review"),
        _event(venue_id="osm_node_1", verdict="reject"),
    ]
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(_simple_resp(["jazz"]))
        update("Austin", events)
        assert mock_cls.return_value.invoke.call_count == 1


def test_update_writes_tags_to_db():
    events = [
        _event(venue_id="osm_node_1", title="Jazz Night", verdict="accept"),
        _event(venue_id="osm_node_1", title="Blues Show", verdict="accept"),
    ]
    resp = json.dumps({
        "event_tags": [
            {"event_idx": 0, "tags": ["jazz"]},
            {"event_idx": 1, "tags": ["jazz", "blues"]},
        ],
        "entities": [],
    })
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(resp)
        update("Austin", events)

    tags = {t["tag"]: t["weight"] for t in db.get_kg_tags_for_venue("osm_node_1")}
    assert tags["jazz"] == pytest.approx(1.0)
    assert tags["blues"] == pytest.approx(0.5)


def test_update_writes_entities_to_db():
    resp = json.dumps({
        "event_tags": [{"event_idx": 0, "tags": ["jazz"]}],
        "entities": [{"name": "Miles Davis", "type": "person"}],
    })
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(resp)
        update("Austin", [_event(verdict="accept")])

    entities = db.get_kg_entities_for_venue("osm_node_1")
    assert len(entities) == 1
    assert entities[0]["entity_name"] == "Miles Davis"
    assert entities[0]["entity_type"] == "person"


def test_update_normalizes_tags():
    resp = json.dumps({
        "event_tags": [{"event_idx": 0, "tags": ["Live Music", "Contemporary-Art"]}],
        "entities": [],
    })
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(resp)
        update("Austin", [_event(verdict="accept")])

    tags = {t["tag"] for t in db.get_kg_tags_for_venue("osm_node_1")}
    assert "live_music" in tags
    assert "contemporary_art" in tags


def test_update_computes_similarity_for_overlapping_venues():
    events = [
        _event(venue_id="osm_node_1", verdict="accept"),
        _event(venue_id="osm_node_2", verdict="accept"),
    ]
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(_simple_resp(["jazz"]))
        update("Austin", events)

    pairs = db.get_kg_similarity_for_venue("osm_node_1")
    assert len(pairs) == 1
    assert pairs[0]["other_venue_id"] == "osm_node_2"
    assert pairs[0]["score"] == pytest.approx(1.0)


def test_update_does_not_store_low_similarity():
    events = [
        _event(venue_id="osm_node_1", verdict="accept"),
        _event(venue_id="osm_node_2", verdict="accept"),
    ]
    responses = [
        _simple_resp(["jazz"]),
        _simple_resp(["film"]),
    ]
    call_count = [0]

    def side_effect(*args, **kwargs):
        r = MagicMock()
        r.content = responses[call_count[0] % 2]
        call_count[0] += 1
        return r

    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.side_effect = side_effect
        mock_cls.return_value = mock_llm
        update("Austin", events)

    pairs = db.get_kg_similarity_for_venue("osm_node_1")
    assert len(pairs) == 0


def test_update_clears_stale_similarity():
    db.upsert_kg_similarity("osm_node_1", "osm_node_2", 0.9, "Austin")

    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(_simple_resp(["jazz"]))
        update("Austin", [_event(venue_id="osm_node_1", verdict="accept")])

    pairs = db.get_kg_similarity_for_venue("osm_node_1")
    assert len(pairs) == 0


def test_update_handles_llm_failure_gracefully():
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.side_effect = Exception("API error")
        mock_cls.return_value = mock_llm
        update("Austin", [_event(verdict="accept")])

    assert db.get_kg_tags_for_venue("osm_node_1") == []


def test_update_handles_bad_json_gracefully():
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm("not json")
        update("Austin", [_event(verdict="accept")])

    assert db.get_kg_tags_for_venue("osm_node_1") == []


def test_update_symmetric_pair_stored_correctly():
    events = [
        _event(venue_id="osm_node_2", verdict="accept"),
        _event(venue_id="osm_node_1", verdict="accept"),
    ]
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(_simple_resp(["jazz"]))
        update("Austin", events)

    pairs_1 = db.get_kg_similarity_for_venue("osm_node_1")
    pairs_2 = db.get_kg_similarity_for_venue("osm_node_2")
    assert len(pairs_1) == 1
    assert len(pairs_2) == 1
    assert pairs_1[0]["other_venue_id"] == "osm_node_2"


def test_update_ignores_invalid_entity_types():
    resp = json.dumps({
        "event_tags": [{"event_idx": 0, "tags": ["jazz"]}],
        "entities": [
            {"name": "Valid Entity", "type": "person"},
            {"name": "Bad Entity", "type": "invalid_type"},
        ],
    })
    with patch("agents.knowledge_graph.ChatOpenAI") as mock_cls:
        mock_cls.return_value = _mock_llm(resp)
        update("Austin", [_event(verdict="accept")])

    entities = db.get_kg_entities_for_venue("osm_node_1")
    assert len(entities) == 1
    assert entities[0]["entity_name"] == "Valid Entity"
