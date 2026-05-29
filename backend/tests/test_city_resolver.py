"""Tests for M01 — City Resolver. All HTTP calls are mocked."""

from unittest.mock import MagicMock, patch

import httpx
import pytest

from agents.city_resolver import CityNotFoundError, resolve

# ── Fixtures — realistic Nominatim jsonv2 responses ───────────────────────────

AUSTIN_RESULT = {
    "place_id": 283423568,
    "osm_type": "relation",
    "osm_id": 113314,
    "lat": "30.2711286",
    "lon": "-97.7436995",
    "display_name": "Austin, Travis County, Texas, United States",
    "class": "place",
    "type": "city",
    "importance": 0.7776519895,
    "address": {
        "city": "Austin",
        "county": "Travis County",
        "state": "Texas",
        "country": "United States",
        "country_code": "us",
    },
}

LONDON_RESULT = {
    "place_id": 65606,
    "osm_type": "relation",
    "osm_id": 65606,
    "lat": "51.5074456",
    "lon": "-0.1277653",
    "display_name": "London, Greater London, England, United Kingdom",
    "class": "place",
    "type": "city",
    "importance": 0.9756419,
    "address": {
        "city": "London",
        # no "state" key — England regions don't always appear
        "country": "United Kingdom",
        "country_code": "gb",
    },
}

# A lower-importance Springfield entry (should be ignored when a higher one exists)
SPRINGFIELD_IL = {
    "place_id": 1001,
    "osm_type": "relation",
    "osm_id": 1001,
    "lat": "39.7990175",
    "lon": "-89.6439575",
    "display_name": "Springfield, Sangamon County, Illinois, United States",
    "class": "place",
    "type": "city",
    "importance": 0.45,
    "address": {
        "city": "Springfield",
        "state": "Illinois",
        "country": "United States",
        "country_code": "us",
    },
}

SPRINGFIELD_MO = {
    "place_id": 1002,
    "osm_type": "relation",
    "osm_id": 1002,
    "lat": "37.2153455",
    "lon": "-93.2982436",
    "display_name": "Springfield, Greene County, Missouri, United States",
    "class": "place",
    "type": "city",
    "importance": 0.55,   # higher importance — should be picked
    "address": {
        "city": "Springfield",
        "state": "Missouri",
        "country": "United States",
        "country_code": "us",
    },
}

# A non-place result that should be filtered out
AMENITY_RESULT = {
    "place_id": 9999,
    "osm_type": "node",
    "osm_id": 9999,
    "lat": "30.27",
    "lon": "-97.74",
    "display_name": "Austin Public Library, Main Street, Austin, Texas",
    "class": "amenity",    # NOT "place" — should be ignored
    "type": "library",
    "importance": 0.99,    # even higher importance, but wrong class
    "address": {
        "amenity": "Austin Public Library",
        "country_code": "us",
        "country": "United States",
    },
}


def _mock_response(json_data, status_code=200):
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = status_code
    mock.json.return_value = json_data
    mock.raise_for_status = MagicMock()
    if status_code >= 400:
        mock.raise_for_status.side_effect = httpx.HTTPStatusError(
            "error", request=MagicMock(), response=mock
        )
    return mock


# ── Happy path ────────────────────────────────────────────────────────────────


@patch("agents.city_resolver.httpx.get")
def test_resolve_returns_city_info(mock_get):
    mock_get.return_value = _mock_response([AUSTIN_RESULT])
    city = resolve("Austin TX")

    assert city.name == "Austin"
    assert city.state == "Texas"
    assert city.country == "US"
    assert city.lat == pytest.approx(30.2711286)
    assert city.lon == pytest.approx(-97.7436995)


@patch("agents.city_resolver.httpx.get")
def test_resolve_display_string_with_state(mock_get):
    mock_get.return_value = _mock_response([AUSTIN_RESULT])
    city = resolve("Austin TX")
    assert city.display == "Austin, Texas, United States"


@patch("agents.city_resolver.httpx.get")
def test_resolve_display_string_without_state(mock_get):
    """Cities without a state in Nominatim address (e.g. London) omit the state segment."""
    mock_get.return_value = _mock_response([LONDON_RESULT])
    city = resolve("London")
    assert city.display == "London, United Kingdom"
    assert city.state is None


@patch("agents.city_resolver.httpx.get")
def test_resolve_country_code_uppercased(mock_get):
    mock_get.return_value = _mock_response([AUSTIN_RESULT])
    city = resolve("Austin TX")
    assert city.country == "US"   # Nominatim returns "us" lowercase; we uppercase it


@patch("agents.city_resolver.httpx.get")
def test_resolve_correct_nominatim_params(mock_get):
    mock_get.return_value = _mock_response([AUSTIN_RESULT])
    resolve("Austin TX")

    call_kwargs = mock_get.call_args
    params = call_kwargs.kwargs.get("params") or call_kwargs.args[1] if len(call_kwargs.args) > 1 else {}
    # Check via the actual call args
    _, kwargs = call_kwargs
    params = kwargs.get("params", {})
    assert params.get("format") == "jsonv2"
    assert params.get("limit") == 5
    assert "featuretype" in params
    assert params.get("addressdetails") == 1


# ── Ambiguous name — picks highest importance ─────────────────────────────────


@patch("agents.city_resolver.httpx.get")
def test_resolve_ambiguous_picks_highest_importance(mock_get):
    """When multiple cities share a name, the one with the highest importance wins."""
    mock_get.return_value = _mock_response([SPRINGFIELD_IL, SPRINGFIELD_MO])
    city = resolve("Springfield")
    # MO has importance 0.55 vs IL's 0.45
    assert city.state == "Missouri"


@patch("agents.city_resolver.httpx.get")
def test_resolve_filters_non_place_class(mock_get):
    """Results with class != 'place' must be discarded even if importance is higher."""
    mock_get.return_value = _mock_response([AMENITY_RESULT, AUSTIN_RESULT])
    city = resolve("Austin TX")
    assert city.name == "Austin"   # AMENITY_RESULT is filtered out


@patch("agents.city_resolver.httpx.get")
def test_resolve_filters_way_osm_type(mock_get):
    """osm_type='way' is not in (node, relation) — must be filtered out."""
    way_result = {**AUSTIN_RESULT, "osm_type": "way", "importance": 0.99}
    mock_get.return_value = _mock_response([way_result, AUSTIN_RESULT])
    city = resolve("Austin TX")
    # way_result is filtered; we get the valid relation
    assert city.name == "Austin"


# ── Not found ─────────────────────────────────────────────────────────────────


@patch("agents.city_resolver.httpx.get")
def test_resolve_raises_when_empty_results(mock_get):
    mock_get.return_value = _mock_response([])
    with pytest.raises(CityNotFoundError):
        resolve("Zxqyvwxyz")


@patch("agents.city_resolver.httpx.get")
def test_resolve_raises_when_no_place_class_results(mock_get):
    """All results filtered out → same error as empty."""
    mock_get.return_value = _mock_response([AMENITY_RESULT])
    with pytest.raises(CityNotFoundError):
        resolve("Austin TX")


@patch("agents.city_resolver.httpx.get")
def test_city_not_found_error_message_contains_query(mock_get):
    mock_get.return_value = _mock_response([])
    with pytest.raises(CityNotFoundError, match="Zxqyvwxyz"):
        resolve("Zxqyvwxyz")


# ── HTTP errors ───────────────────────────────────────────────────────────────


@patch("agents.city_resolver.httpx.get")
def test_resolve_raises_on_http_error(mock_get):
    mock_get.side_effect = httpx.HTTPError("connection refused")
    with pytest.raises(CityNotFoundError, match="Nominatim unavailable"):
        resolve("Austin TX")


@patch("agents.city_resolver.httpx.get")
def test_resolve_raises_on_timeout(mock_get):
    mock_get.side_effect = httpx.TimeoutException("timed out")
    with pytest.raises(CityNotFoundError, match="Nominatim unavailable"):
        resolve("Austin TX")


@patch("agents.city_resolver.httpx.get")
def test_resolve_raises_on_http_status_error(mock_get):
    mock_get.return_value = _mock_response([], status_code=429)
    mock_get.return_value.raise_for_status.side_effect = httpx.HTTPStatusError(
        "429 Too Many Requests", request=MagicMock(), response=MagicMock()
    )
    with pytest.raises(CityNotFoundError, match="Nominatim unavailable"):
        resolve("Austin TX")


# ── Address field fallbacks ───────────────────────────────────────────────────


@patch("agents.city_resolver.httpx.get")
def test_resolve_uses_town_when_no_city_key(mock_get):
    """Nominatim sometimes returns 'town' instead of 'city' for the settlement name."""
    result = {
        **AUSTIN_RESULT,
        "address": {
            "town": "Cedar Park",       # no "city" key
            "state": "Texas",
            "country": "United States",
            "country_code": "us",
        },
    }
    mock_get.return_value = _mock_response([result])
    city = resolve("Cedar Park TX")
    assert city.name == "Cedar Park"


@patch("agents.city_resolver.httpx.get")
def test_resolve_uses_village_as_last_resort(mock_get):
    result = {
        **AUSTIN_RESULT,
        "lat": "42.0",
        "lon": "-72.0",
        "address": {
            "village": "Tiny Town",
            "country": "United States",
            "country_code": "us",
        },
    }
    mock_get.return_value = _mock_response([result])
    city = resolve("Tiny Town")
    assert city.name == "Tiny Town"
    assert city.state is None
