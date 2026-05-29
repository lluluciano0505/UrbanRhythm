"""Tests for M02 — Venue Discovery. HTTP calls mocked; DB uses in-memory SQLite."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import httpx
import pytest

import data.database as db
from agents.venue_discovery import (
    _build_address,
    _build_overpass_query,
    _classify_type,
    _parse_elements,
    _row_to_venue,
    discover,
)
from models.types import CityInfo, Venue

# ── Fixtures ──────────────────────────────────────────────────────────────────

AUSTIN = CityInfo(
    name="Austin",
    state="Texas",
    country="US",
    lat=30.2711,
    lon=-97.7437,
    display="Austin, Texas, United States",
)

ALL_TYPES = ["library", "museum", "gallery", "arts_centre"]


@pytest.fixture(autouse=True)
def fresh_db():
    db.init_db(":memory:")


def _overpass_response(elements: list[dict]):
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = 200
    mock.json.return_value = {"elements": elements}
    mock.raise_for_status = MagicMock()
    return mock


# Sample OSM elements
NODE_LIBRARY = {
    "type": "node",
    "id": 111111,
    "lat": 30.2711,
    "lon": -97.7437,
    "tags": {
        "name": "Austin Public Library",
        "amenity": "library",
        "website": "https://library.austintexas.gov",
        "addr:housenumber": "710",
        "addr:street": "W César Chávez St",
        "addr:city": "Austin",
    },
}

WAY_MUSEUM = {
    "type": "way",
    "id": 222222,
    "center": {"lat": 30.2800, "lon": -97.7500},
    "tags": {
        "name": "Blanton Museum of Art",
        "tourism": "museum",
        "website": "https://blantonmuseum.org",
    },
}

NODE_GALLERY = {
    "type": "node",
    "id": 333333,
    "lat": 30.2750,
    "lon": -97.7400,
    "tags": {
        "name": "Wally Workman Gallery",
        "tourism": "gallery",
    },
}

NODE_ARTS_CENTRE = {
    "type": "node",
    "id": 444444,
    "lat": 30.2600,
    "lon": -97.7600,
    "tags": {
        "name": "Long Center for the Performing Arts",
        "amenity": "arts_centre",
        "website": "https://thelongcenter.org",
    },
}

# An arts_centre that also has tourism=gallery → should be classified as gallery
NODE_DUAL_TAGGED = {
    "type": "node",
    "id": 555555,
    "lat": 30.2650,
    "lon": -97.7550,
    "tags": {
        "name": "Arthouse Gallery Center",
        "amenity": "arts_centre",
        "tourism": "gallery",    # tourism=gallery takes precedence
    },
}

# Node with no name — should be skipped
NODE_NO_NAME = {
    "type": "node",
    "id": 666666,
    "lat": 30.2700,
    "lon": -97.7400,
    "tags": {
        "amenity": "library",
        # no "name" tag
    },
}

# Way with no center coordinates — should be skipped
WAY_NO_CENTER = {
    "type": "way",
    "id": 777777,
    "tags": {
        "name": "Mystery Museum",
        "tourism": "museum",
    },
    # no "center" key
}


# ── _classify_type ────────────────────────────────────────────────────────────


def test_classify_library():
    assert _classify_type({"amenity": "library"}) == "library"


def test_classify_museum():
    assert _classify_type({"tourism": "museum"}) == "museum"


def test_classify_gallery():
    assert _classify_type({"tourism": "gallery"}) == "gallery"


def test_classify_arts_centre():
    assert _classify_type({"amenity": "arts_centre"}) == "arts_centre"


def test_classify_dual_tagged_gallery_wins():
    """tourism=gallery takes precedence over amenity=arts_centre."""
    assert _classify_type({"amenity": "arts_centre", "tourism": "gallery"}) == "gallery"


def test_classify_unknown_returns_none():
    assert _classify_type({"amenity": "cafe"}) is None


def test_classify_empty_tags_returns_none():
    assert _classify_type({}) is None


# ── _build_address ────────────────────────────────────────────────────────────


def test_build_address_full():
    tags = {"addr:housenumber": "710", "addr:street": "Main St", "addr:city": "Austin"}
    assert _build_address(tags) == "710 Main St, Austin"


def test_build_address_street_only():
    tags = {"addr:street": "Main St"}
    assert _build_address(tags) == "Main St"


def test_build_address_street_and_city():
    tags = {"addr:street": "Main St", "addr:city": "Austin"}
    assert _build_address(tags) == "Main St, Austin"


def test_build_address_empty_tags():
    assert _build_address({}) is None


def test_build_address_number_without_street():
    # house number alone doesn't make a useful address
    assert _build_address({"addr:housenumber": "710"}) is None


# ── _parse_elements ───────────────────────────────────────────────────────────


def test_parse_node_venue():
    venues = _parse_elements([NODE_LIBRARY], AUSTIN, ALL_TYPES)
    assert len(venues) == 1
    v = venues[0]
    assert v.id == "osm_node_111111"
    assert v.name == "Austin Public Library"
    assert v.type == "library"
    assert v.lat == pytest.approx(30.2711)
    assert v.lon == pytest.approx(-97.7437)
    assert v.website == "https://library.austintexas.gov"
    assert v.address == "710 W César Chávez St, Austin"
    assert v.city == "Austin"
    assert v.country == "US"
    assert v.osm_id == "111111"


def test_parse_way_venue_uses_center():
    venues = _parse_elements([WAY_MUSEUM], AUSTIN, ALL_TYPES)
    assert len(venues) == 1
    v = venues[0]
    assert v.id == "osm_way_222222"
    assert v.lat == pytest.approx(30.2800)
    assert v.lon == pytest.approx(-97.7500)


def test_parse_skips_no_name():
    venues = _parse_elements([NODE_NO_NAME], AUSTIN, ALL_TYPES)
    assert venues == []


def test_parse_skips_way_without_center():
    venues = _parse_elements([WAY_NO_CENTER], AUSTIN, ALL_TYPES)
    assert venues == []


def test_parse_type_filter_respected():
    elements = [NODE_LIBRARY, WAY_MUSEUM, NODE_GALLERY]
    venues = _parse_elements(elements, AUSTIN, ["library"])
    assert len(venues) == 1
    assert venues[0].type == "library"


def test_parse_dual_tagged_classified_as_gallery():
    venues = _parse_elements([NODE_DUAL_TAGGED], AUSTIN, ALL_TYPES)
    assert len(venues) == 1
    assert venues[0].type == "gallery"


def test_parse_dual_tagged_in_arts_centre_request_not_returned():
    """When only arts_centre is requested, dual-tagged element must NOT appear
    (it was classified as gallery)."""
    venues = _parse_elements([NODE_DUAL_TAGGED], AUSTIN, ["arts_centre"])
    assert venues == []


def test_parse_all_types():
    elements = [NODE_LIBRARY, WAY_MUSEUM, NODE_GALLERY, NODE_ARTS_CENTRE]
    venues = _parse_elements(elements, AUSTIN, ALL_TYPES)
    assert len(venues) == 4
    types_found = {v.type for v in venues}
    assert types_found == {"library", "museum", "gallery", "arts_centre"}


def test_parse_contact_website_fallback():
    el = {**NODE_LIBRARY, "tags": {**NODE_LIBRARY["tags"], "website": None, "contact:website": "https://alt.example.com"}}
    # The tags dict has website=None, contact:website set
    el["tags"] = {k: v for k, v in NODE_LIBRARY["tags"].items() if k != "website"}
    el["tags"]["contact:website"] = "https://alt.example.com"
    venues = _parse_elements([el], AUSTIN, ALL_TYPES)
    assert venues[0].website == "https://alt.example.com"


# ── _build_overpass_query ─────────────────────────────────────────────────────


def test_query_contains_library_filter():
    q = _build_overpass_query(30.27, -97.74, 30000, ["library"])
    assert '"amenity"="library"' in q


def test_query_contains_museum_filter():
    q = _build_overpass_query(30.27, -97.74, 30000, ["museum"])
    assert '"tourism"="museum"' in q


def test_query_omits_unrequested_types():
    q = _build_overpass_query(30.27, -97.74, 30000, ["library"])
    assert '"tourism"="museum"' not in q
    assert '"arts_centre"' not in q


def test_query_contains_both_node_and_way():
    q = _build_overpass_query(30.27, -97.74, 30000, ["library"])
    assert "node" in q
    assert "way" in q


def test_query_radius_in_meters():
    q = _build_overpass_query(30.27, -97.74, 30, ["library"])  # 30m — tiny
    assert "around:30," in q


def test_query_all_types():
    q = _build_overpass_query(30.27, -97.74, 30000, ALL_TYPES)
    assert '"amenity"="library"' in q
    assert '"tourism"="museum"' in q
    assert '"tourism"="gallery"' in q
    assert '"amenity"="arts_centre"' in q


def test_query_has_json_output_and_center():
    q = _build_overpass_query(30.27, -97.74, 30000, ["library"])
    assert "[out:json]" in q
    assert "out center tags" in q


# ── discover() — cache miss path ──────────────────────────────────────────────


@patch("agents.venue_discovery.httpx.post")
def test_discover_cache_miss_fetches_overpass(mock_post):
    mock_post.return_value = _overpass_response([NODE_LIBRARY])
    venues = discover(AUSTIN, 30, ["library"])
    assert mock_post.called
    assert len(venues) == 1
    assert venues[0].name == "Austin Public Library"


@patch("agents.venue_discovery.httpx.post")
def test_discover_upserts_venues_to_db(mock_post):
    mock_post.return_value = _overpass_response([NODE_LIBRARY, WAY_MUSEUM])
    discover(AUSTIN, 30, ALL_TYPES)
    rows = db.get_venues(city="Austin")
    assert len(rows) == 2


@patch("agents.venue_discovery.httpx.post")
def test_discover_returns_only_requested_types(mock_post):
    mock_post.return_value = _overpass_response([NODE_LIBRARY, WAY_MUSEUM, NODE_GALLERY])
    venues = discover(AUSTIN, 30, ["library"])
    # All three are upserted to DB, but only library is returned
    assert all(v.type == "library" for v in venues)


# ── discover() — cache hit path ───────────────────────────────────────────────


def _insert_fresh_venue(venue_id="osm_node_1", vtype="library"):
    """Insert a venue directly into DB with a fresh last_osm_sync timestamp."""
    v = Venue(
        id=venue_id,
        name="Cached Venue",
        type=vtype,
        city="Austin",
        country="US",
        lat=30.27,
        lon=-97.74,
        osm_id=venue_id.split("_")[-1],
    )
    db.upsert_venue(v)
    # The upsert sets last_osm_sync = utcnow(), so the cache is already fresh.


@patch("agents.venue_discovery.httpx.post")
def test_discover_cache_hit_skips_overpass(mock_post):
    _insert_fresh_venue()
    venues = discover(AUSTIN, 30, ["library"])
    mock_post.assert_not_called()
    assert len(venues) == 1


@patch("agents.venue_discovery.httpx.post")
def test_discover_cache_hit_filters_by_type(mock_post):
    _insert_fresh_venue("osm_node_1", "library")
    _insert_fresh_venue("osm_node_2", "museum")
    venues = discover(AUSTIN, 30, ["museum"])
    mock_post.assert_not_called()
    assert len(venues) == 1
    assert venues[0].type == "museum"


@patch("agents.venue_discovery.httpx.post")
def test_discover_stale_cache_hits_overpass(mock_post):
    """If the cached venues are older than 7 days, Overpass must be queried."""
    _insert_fresh_venue()

    # Manually backdate last_osm_sync to 8 days ago
    stale_ts = (datetime.utcnow() - timedelta(days=8)).isoformat()
    with db._conn() as c:
        c.execute("UPDATE venues SET last_osm_sync = ?", (stale_ts,))

    mock_post.return_value = _overpass_response([NODE_LIBRARY])
    discover(AUSTIN, 30, ["library"])
    mock_post.assert_called_once()


@patch("agents.venue_discovery.httpx.post")
def test_discover_empty_db_hits_overpass(mock_post):
    mock_post.return_value = _overpass_response([])
    discover(AUSTIN, 30, ALL_TYPES)
    mock_post.assert_called_once()


# ── discover() — node vs way ──────────────────────────────────────────────────


@patch("agents.venue_discovery.httpx.post")
def test_discover_handles_node_elements(mock_post):
    mock_post.return_value = _overpass_response([NODE_LIBRARY])
    venues = discover(AUSTIN, 30, ALL_TYPES)
    assert venues[0].id == "osm_node_111111"


@patch("agents.venue_discovery.httpx.post")
def test_discover_handles_way_elements(mock_post):
    mock_post.return_value = _overpass_response([WAY_MUSEUM])
    venues = discover(AUSTIN, 30, ALL_TYPES)
    assert venues[0].id == "osm_way_222222"
    assert venues[0].lat == pytest.approx(30.2800)


@patch("agents.venue_discovery.httpx.post")
def test_discover_skips_nameless_elements(mock_post):
    mock_post.return_value = _overpass_response([NODE_NO_NAME, NODE_LIBRARY])
    venues = discover(AUSTIN, 30, ALL_TYPES)
    assert len(venues) == 1


# ── discover() — error handling ───────────────────────────────────────────────


@patch("agents.venue_discovery.httpx.post")
def test_discover_raises_on_http_error(mock_post):
    mock_post.side_effect = httpx.HTTPError("connection refused")
    with pytest.raises(RuntimeError, match="Overpass API unavailable"):
        discover(AUSTIN, 30, ALL_TYPES)


@patch("agents.venue_discovery.httpx.post")
def test_discover_returns_empty_list_when_no_elements(mock_post):
    mock_post.return_value = _overpass_response([])
    venues = discover(AUSTIN, 30, ALL_TYPES)
    assert venues == []


# ── _row_to_venue ─────────────────────────────────────────────────────────────


def test_row_to_venue_round_trips():
    _insert_fresh_venue("osm_node_99", "museum")
    rows = db.get_venues(city="Austin")
    assert len(rows) == 1
    v = _row_to_venue(rows[0])
    assert isinstance(v, Venue)
    assert v.id == "osm_node_99"
    assert v.type == "museum"
