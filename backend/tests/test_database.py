"""Tests for M11 — Database. All tests use an in-memory SQLite database."""

from datetime import datetime

import pytest

import data.database as db
from models.types import JudgedEvent, Venue


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def fresh_db():
    """Each test gets a clean in-memory database."""
    db.init_db(":memory:")


def _venue(id="osm_node_1", city="Austin", type="library", website="https://example.com"):
    return Venue(
        id=id,
        name="Test Venue",
        type=type,
        city=city,
        country="US",
        lat=30.26,
        lon=-97.74,
        osm_id="1",
        address="123 Main St",
        website=website,
    )


def _event(title="Jazz Night", date="2099-08-01", venue_id="osm_node_1", verdict="accept"):
    return JudgedEvent(
        title=title,
        date=date,
        venue_id=venue_id,
        source_strategy="json_ld",
        description="A great jazz event",
        url="https://example.com/jazz",
        quality_score=0.9,
        verdict=verdict,
        judged_at=datetime(2026, 5, 19, 12, 0, 0),
    )


# ── init_db ───────────────────────────────────────────────────────────────────


def test_init_db_creates_tables():
    venues = db.get_venues()
    assert isinstance(venues, list)  # table exists


def test_init_db_is_idempotent():
    """Calling init_db twice on :memory: resets the database cleanly."""
    db.upsert_venue(_venue())
    db.init_db(":memory:")
    assert db.get_venues() == []


# ── upsert_venue ──────────────────────────────────────────────────────────────


def test_upsert_venue_inserts():
    db.upsert_venue(_venue())
    rows = db.get_venues()
    assert len(rows) == 1
    assert rows[0]["name"] == "Test Venue"


def test_upsert_venue_is_idempotent():
    v = _venue()
    db.upsert_venue(v)
    db.upsert_venue(v)
    assert len(db.get_venues()) == 1


def test_upsert_venue_updates_on_conflict():
    db.upsert_venue(_venue())
    updated = _venue()
    updated.name = "Updated Venue"
    db.upsert_venue(updated)
    rows = db.get_venues()
    assert len(rows) == 1
    assert rows[0]["name"] == "Updated Venue"


# ── get_venues filters ────────────────────────────────────────────────────────


def test_get_venues_filter_by_city():
    db.upsert_venue(_venue(id="osm_node_1", city="Austin"))
    db.upsert_venue(_venue(id="osm_node_2", city="Denver"))
    result = db.get_venues(city="Austin")
    assert len(result) == 1
    assert result[0]["city"] == "Austin"


def test_get_venues_filter_by_type():
    db.upsert_venue(_venue(id="osm_node_1", type="library"))
    db.upsert_venue(_venue(id="osm_node_2", type="museum"))
    result = db.get_venues(types=["museum"])
    assert len(result) == 1
    assert result[0]["type"] == "museum"


def test_get_venues_filter_by_multiple_types():
    db.upsert_venue(_venue(id="osm_node_1", type="library"))
    db.upsert_venue(_venue(id="osm_node_2", type="museum"))
    db.upsert_venue(_venue(id="osm_node_3", type="gallery"))
    result = db.get_venues(types=["library", "museum"])
    assert len(result) == 2


def test_get_venues_filter_has_website_true():
    db.upsert_venue(_venue(id="osm_node_1", website="https://example.com"))
    db.upsert_venue(_venue(id="osm_node_2", website=None))
    result = db.get_venues(has_website=True)
    assert len(result) == 1
    assert result[0]["website"] == "https://example.com"


def test_get_venues_filter_has_website_false():
    db.upsert_venue(_venue(id="osm_node_1", website="https://example.com"))
    db.upsert_venue(_venue(id="osm_node_2", website=None))
    result = db.get_venues(has_website=False)
    assert len(result) == 1
    assert result[0]["website"] is None


def test_get_venues_filter_by_status():
    db.upsert_venue(_venue(id="osm_node_1"))
    db.upsert_venue(_venue(id="osm_node_2"))
    db.update_venue_scrape_status("osm_node_1", "active")
    result = db.get_venues(status="active")
    assert len(result) == 1
    assert result[0]["id"] == "osm_node_1"


def test_get_venues_limit():
    for i in range(5):
        db.upsert_venue(_venue(id=f"osm_node_{i}"))
    result = db.get_venues(limit=3)
    assert len(result) == 3


# ── upsert_event ──────────────────────────────────────────────────────────────


def test_upsert_event_inserts():
    db.upsert_venue(_venue())
    db.upsert_event(_event(), city="Austin")
    events = db.get_events(city="Austin")
    assert len(events) == 1
    assert events[0]["title"] == "Jazz Night"


def test_upsert_event_deduplication_key():
    """Same venue_id + date + title → same record, no duplicates."""
    db.upsert_venue(_venue())
    e = _event()
    db.upsert_event(e, city="Austin")
    db.upsert_event(e, city="Austin")
    assert len(db.get_events()) == 1


def test_upsert_event_overwrites_on_re_run():
    """FR-14b: re-inserting same event key updates fields in place."""
    db.upsert_venue(_venue())
    e1 = _event(verdict="review")
    e1.quality_score = 0.5
    db.upsert_event(e1, city="Austin")

    e2 = _event(verdict="accept")  # same title/date/venue
    e2.quality_score = 0.9
    db.upsert_event(e2, city="Austin")

    events = db.get_events()
    assert len(events) == 1
    assert events[0]["verdict"] == "accept"
    assert events[0]["quality_score"] == pytest.approx(0.9)


def test_upsert_event_different_titles_are_separate():
    db.upsert_venue(_venue())
    db.upsert_event(_event(title="Jazz Night"), city="Austin")
    db.upsert_event(_event(title="Poetry Reading"), city="Austin")
    assert len(db.get_events()) == 2


# ── get_events filters ────────────────────────────────────────────────────────


def test_get_events_filter_by_verdict():
    db.upsert_venue(_venue())
    db.upsert_event(_event(title="A", verdict="accept"), city="Austin")
    db.upsert_event(_event(title="B", verdict="review"), city="Austin")
    db.upsert_event(_event(title="C", verdict="reject"), city="Austin")

    accepted = db.get_events(verdicts=["accept"])
    assert len(accepted) == 1
    assert accepted[0]["verdict"] == "accept"


def test_get_events_filter_by_multiple_verdicts():
    db.upsert_venue(_venue())
    db.upsert_event(_event(title="A", verdict="accept"), city="Austin")
    db.upsert_event(_event(title="B", verdict="review"), city="Austin")
    db.upsert_event(_event(title="C", verdict="reject"), city="Austin")

    result = db.get_events(verdicts=["accept", "review"])
    assert len(result) == 2


def test_get_events_filter_by_date_range():
    db.upsert_venue(_venue())
    db.upsert_event(_event(title="Early", date="2099-07-01"), city="Austin")
    db.upsert_event(_event(title="Mid", date="2099-08-01"), city="Austin")
    db.upsert_event(_event(title="Late", date="2099-09-01"), city="Austin")

    result = db.get_events(date_from="2099-07-15", date_to="2099-08-15")
    assert len(result) == 1
    assert result[0]["title"] == "Mid"


def test_get_events_filter_by_venue_type():
    db.upsert_venue(_venue(id="osm_node_1", type="library"))
    db.upsert_venue(_venue(id="osm_node_2", type="museum"))
    db.upsert_event(_event(title="Library Event", venue_id="osm_node_1"), city="Austin")
    db.upsert_event(_event(title="Museum Event", venue_id="osm_node_2"), city="Austin")

    result = db.get_events(venue_type="museum")
    assert len(result) == 1
    assert result[0]["title"] == "Museum Event"


# ── event ID determinism ──────────────────────────────────────────────────────


def test_event_id_is_deterministic():
    id1 = db._event_id("v1", "2099-01-01", "Jazz Night")
    id2 = db._event_id("v1", "2099-01-01", "Jazz Night")
    assert id1 == id2
    assert len(id1) == 16


def test_event_id_differs_for_different_inputs():
    assert db._event_id("v1", "2099-01-01", "Jazz") != db._event_id("v1", "2099-01-01", "Blues")
    assert db._event_id("v1", "2099-01-01", "Jazz") != db._event_id("v2", "2099-01-01", "Jazz")
    assert db._event_id("v1", "2099-01-01", "Jazz") != db._event_id("v1", "2099-01-02", "Jazz")


# ── upsert_playbook ───────────────────────────────────────────────────────────


def test_upsert_playbook_inserts_success():
    db.upsert_playbook("example.com", "json_ld", {"path": "/events"}, success=True)
    row = db.get_playbook("example.com")
    assert row is not None
    assert row["strategy"] == "json_ld"
    assert row["success_count"] == 1
    assert row["failure_count"] == 0
    assert row["strategy_detail"] == {"path": "/events"}


def test_upsert_playbook_inserts_failure():
    db.upsert_playbook("example.com", None, {}, success=False)
    row = db.get_playbook("example.com")
    assert row["success_count"] == 0
    assert row["failure_count"] == 1


def test_upsert_playbook_increments_success_count():
    db.upsert_playbook("example.com", "json_ld", {}, success=True)
    db.upsert_playbook("example.com", "json_ld", {}, success=True)
    row = db.get_playbook("example.com")
    assert row["success_count"] == 2
    assert row["failure_count"] == 0


def test_upsert_playbook_increments_failure_count():
    db.upsert_playbook("example.com", None, {}, success=False)
    db.upsert_playbook("example.com", None, {}, success=False)
    row = db.get_playbook("example.com")
    assert row["success_count"] == 0
    assert row["failure_count"] == 2


def test_upsert_playbook_mixed_counts():
    db.upsert_playbook("example.com", "json_ld", {}, success=True)
    db.upsert_playbook("example.com", None, {}, success=False)
    db.upsert_playbook("example.com", "json_ld", {}, success=True)
    row = db.get_playbook("example.com")
    assert row["success_count"] == 2
    assert row["failure_count"] == 1


def test_upsert_playbook_failure_preserves_strategy():
    """Recording a failure must not wipe out an existing successful strategy."""
    db.upsert_playbook("example.com", "ical", {"path": "/calendar.ics"}, success=True)
    db.upsert_playbook("example.com", None, {}, success=False)
    row = db.get_playbook("example.com")
    assert row["strategy"] == "ical"


def test_upsert_playbook_stores_cms_type():
    db.upsert_playbook("example.com", "json_ld", {}, success=True, cms_type="wordpress")
    row = db.get_playbook("example.com")
    assert row["cms_type"] == "wordpress"


def test_get_playbook_returns_none_for_unknown_domain():
    assert db.get_playbook("unknown.com") is None


def test_get_playbook_decodes_strategy_detail_json():
    db.upsert_playbook("example.com", "ical", {"path": "/calendar.ics", "tries": 3}, success=True)
    row = db.get_playbook("example.com")
    assert isinstance(row["strategy_detail"], dict)
    assert row["strategy_detail"]["path"] == "/calendar.ics"
    assert row["strategy_detail"]["tries"] == 3


# ── kg_tags ───────────────────────────────────────────────────────────────────


def test_upsert_kg_tags_inserts_and_replaces():
    db.upsert_venue(_venue())
    db.upsert_kg_tags("osm_node_1", [{"tag": "jazz", "weight": 0.8}], city="Austin")
    # Replace with new tags
    db.upsert_kg_tags("osm_node_1", [{"tag": "blues", "weight": 0.6}], city="Austin")
    tags = db.get_kg_tags_for_venue("osm_node_1")
    assert len(tags) == 1
    assert tags[0]["tag"] == "blues"


def test_get_kg_tags_aggregates_by_city():
    db.upsert_venue(_venue(id="osm_node_1"))
    db.upsert_venue(_venue(id="osm_node_2"))
    db.upsert_kg_tags("osm_node_1", [{"tag": "jazz", "weight": 0.8}], city="Austin")
    db.upsert_kg_tags("osm_node_2", [{"tag": "jazz", "weight": 0.6}], city="Austin")
    tags = db.get_kg_tags("Austin")
    assert len(tags) == 1
    assert tags[0]["tag"] == "jazz"
    assert tags[0]["venue_count"] == 2


# ── kg_similarity ─────────────────────────────────────────────────────────────


def test_upsert_kg_similarity_enforces_lexicographic_order():
    db.upsert_venue(_venue(id="osm_node_b"))
    db.upsert_venue(_venue(id="osm_node_a"))
    db.upsert_kg_similarity("osm_node_b", "osm_node_a", 0.75, city="Austin")
    # Should be stored as (a, b) not (b, a)
    result = db.get_kg_similarity_for_venue("osm_node_a")
    assert len(result) == 1
    assert result[0]["score"] == pytest.approx(0.75)


def test_upsert_kg_similarity_updates_score():
    db.upsert_venue(_venue(id="osm_node_a"))
    db.upsert_venue(_venue(id="osm_node_b"))
    db.upsert_kg_similarity("osm_node_a", "osm_node_b", 0.5, city="Austin")
    db.upsert_kg_similarity("osm_node_a", "osm_node_b", 0.9, city="Austin")
    result = db.get_kg_similarity_for_venue("osm_node_a")
    assert result[0]["score"] == pytest.approx(0.9)


# ── run table ─────────────────────────────────────────────────────────────────


def test_insert_and_finish_run():
    started = datetime(2026, 5, 19, 10, 0, 0)
    finished = datetime(2026, 5, 19, 10, 30, 0)
    db.insert_run("run_001", "Austin", 30.0, started)
    db.finish_run("run_001", finished, {"venues_total": 50, "events_accepted": 120})

    # Verify by querying events (indirect; we don't expose get_run in the interface)
    # Just confirm no exception was raised — the run table has no dedicated getter in M11.
    # A simple existence check via raw query on the memory connection:
    with db._conn() as c:
        row = c.execute("SELECT * FROM runs WHERE run_id = 'run_001'").fetchone()
    assert row is not None
    assert row["city"] == "Austin"
    assert row["finished_at"] is not None
