"""Tests for M04 — Scraper Tools. All HTTP and LLM calls mocked."""

import json
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import httpx
import pytest

from agents.scraper_tools import (
    FetchError,
    _extract_events_llm_impl,
    _extract_json_ld_impl,
    _find_ical_urls,
    _parse_ical_impl,
    _search_web_impl,
    fetch_page,
    navigate_to_events,
)
from models.types import RawEvent

# ── Fixtures & helpers ────────────────────────────────────────────────────────

TODAY = date.today()
FUTURE = (TODAY + timedelta(days=30)).strftime("%Y-%m-%d")
PAST = (TODAY - timedelta(days=1)).strftime("%Y-%m-%d")
FUTURE_DATE = TODAY + timedelta(days=30)
PAST_DATE = TODAY - timedelta(days=1)


def _mock_http_response(text: str, status: int = 200) -> MagicMock:
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = status
    mock.text = text
    mock.content = text.encode()
    mock.raise_for_status = MagicMock()
    if status >= 400:
        mock.raise_for_status.side_effect = httpx.HTTPStatusError(
            "error", request=MagicMock(), response=mock
        )
    return mock


def _ical_bytes(events: list[dict]) -> bytes:
    """Build minimal .ics bytes from a list of event dicts with SUMMARY and DTSTART."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0"]
    for ev in events:
        lines += [
            "BEGIN:VEVENT",
            f"SUMMARY:{ev['summary']}",
            f"DTSTART:{ev['dtstart']}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines).encode()


# ── _find_ical_urls ───────────────────────────────────────────────────────────


def test_find_ical_raw_ics_url():
    text = "Subscribe at https://example.com/feed.ics for updates"
    urls = _find_ical_urls(text)
    assert "https://example.com/feed.ics" in urls


def test_find_ical_markdown_link():
    text = "[Download calendar](https://example.com/events/calendar.ics)"
    urls = _find_ical_urls(text)
    assert "https://example.com/events/calendar.ics" in urls


def test_find_ical_webcal_url():
    text = "Add to calendar: webcal://example.com/events.ics"
    urls = _find_ical_urls(text)
    assert "webcal://example.com/events.ics" in urls


def test_find_ical_contains_ical_keyword():
    text = "https://example.com/?ical=1 feed available"
    urls = _find_ical_urls(text)
    assert any("ical" in u.lower() for u in urls)


def test_find_ical_contains_calendar_keyword():
    text = "Visit https://example.com/calendar for all events"
    urls = _find_ical_urls(text)
    assert any("calendar" in u.lower() for u in urls)


def test_find_ical_empty_text():
    assert _find_ical_urls("") == []


def test_find_ical_no_matching_urls():
    text = "Visit https://example.com/about for more info"
    result = _find_ical_urls(text)
    assert result == []


def test_find_ical_deduplicates():
    text = (
        "https://example.com/feed.ics and again https://example.com/feed.ics"
    )
    urls = _find_ical_urls(text)
    assert urls.count("https://example.com/feed.ics") == 1


def test_find_ical_multiple_feeds():
    text = (
        "https://example.com/feed.ics or https://example.com/calendar.ics"
    )
    urls = _find_ical_urls(text)
    assert len(urls) >= 2


# ── _parse_ical_impl ──────────────────────────────────────────────────────────


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_returns_future_event(mock_get):
    ical = _ical_bytes(
        [{"summary": "Jazz Night", "dtstart": FUTURE_DATE.strftime("%Y%m%d")}]
    )
    mock_get.return_value = _mock_http_response(ical.decode())
    mock_get.return_value.content = ical
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert len(events) == 1
    assert events[0].title == "Jazz Night"
    assert events[0].date == FUTURE
    assert events[0].source_strategy == "ical"
    assert events[0].venue_id == ""


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_discards_past_event(mock_get):
    ical = _ical_bytes(
        [{"summary": "Old Concert", "dtstart": PAST_DATE.strftime("%Y%m%d")}]
    )
    mock_get.return_value.content = ical
    mock_get.return_value.raise_for_status = MagicMock()
    mock_get.return_value.status_code = 200
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert events == []


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_keeps_today(mock_get):
    ical = _ical_bytes(
        [{"summary": "Today Event", "dtstart": TODAY.strftime("%Y%m%d")}]
    )
    mock_get.return_value.content = ical
    mock_get.return_value.raise_for_status = MagicMock()
    mock_get.return_value.status_code = 200
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert len(events) == 1


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_empty_calendar(mock_get):
    ical = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR"
    mock_get.return_value.content = ical
    mock_get.return_value.raise_for_status = MagicMock()
    mock_get.return_value.status_code = 200
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert events == []


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_http_error_raises_fetch_error(mock_get):
    mock_get.side_effect = httpx.HTTPError("connection refused")
    with pytest.raises(FetchError):
        _parse_ical_impl("http://example.com/cal.ics")


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_datetime_dtstart_extracts_time(mock_get):
    ical = (
        b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
        b"BEGIN:VEVENT\r\n"
        b"SUMMARY:Evening Show\r\n"
        b"DTSTART:20260815T200000\r\n"
        b"END:VEVENT\r\n"
        b"END:VCALENDAR"
    )
    mock_get.return_value.content = ical
    mock_get.return_value.raise_for_status = MagicMock()
    mock_get.return_value.status_code = 200
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert len(events) == 1
    assert events[0].time == "20:00"


@patch("agents.scraper_tools.httpx.get")
def test_parse_ical_skips_event_without_summary(mock_get):
    ical = (
        b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
        b"BEGIN:VEVENT\r\n"
        b"DTSTART:20260901\r\n"
        b"END:VEVENT\r\n"
        b"END:VCALENDAR"
    )
    mock_get.return_value.content = ical
    mock_get.return_value.raise_for_status = MagicMock()
    mock_get.return_value.status_code = 200
    events = _parse_ical_impl("http://example.com/cal.ics")
    assert events == []


# ── _extract_json_ld_impl ─────────────────────────────────────────────────────

_SINGLE_EVENT_HTML = """
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Piano Recital",
  "startDate": "2026-09-15T19:30:00",
  "description": "A beautiful piano recital",
  "url": "https://example.com/events/piano"
}
</script>
</head></html>
"""

_ARRAY_EVENTS_HTML = """
<html><head>
<script type="application/ld+json">
[
  {"@type": "Event", "name": "Art Walk", "startDate": "2026-08-01"},
  {"@type": "Event", "name": "Film Screening", "startDate": "2026-08-15T18:00:00"}
]
</script>
</head></html>
"""

_GRAPH_EVENT_HTML = """
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {"@type": "Event", "name": "Gallery Opening", "startDate": "2026-10-01"},
    {"@type": "Organization", "name": "The Museum"}
  ]
}
</script>
</head></html>
"""

_NO_JSON_LD_HTML = "<html><body><p>No events here</p></body></html>"

_MALFORMED_JSON_HTML = """
<html><head>
<script type="application/ld+json">
{not valid json
</script>
</head></html>
"""

_OFFERS_HTML = """
<html><head>
<script type="application/ld+json">
{
  "@type": "Event",
  "name": "Jazz Evening",
  "startDate": "2026-07-20",
  "offers": {"price": "15", "priceCurrency": "USD"}
}
</script>
</head></html>
"""


def test_extract_json_ld_single_event():
    events = _extract_json_ld_impl(_SINGLE_EVENT_HTML)
    assert len(events) == 1
    ev = events[0]
    assert ev.title == "Piano Recital"
    assert ev.date == "2026-09-15"
    assert ev.time == "19:30"
    assert ev.description == "A beautiful piano recital"
    assert ev.url == "https://example.com/events/piano"
    assert ev.source_strategy == "json_ld"
    assert ev.venue_id == ""


def test_extract_json_ld_array():
    events = _extract_json_ld_impl(_ARRAY_EVENTS_HTML)
    assert len(events) == 2
    titles = {e.title for e in events}
    assert titles == {"Art Walk", "Film Screening"}


def test_extract_json_ld_array_time_extracted():
    events = _extract_json_ld_impl(_ARRAY_EVENTS_HTML)
    screening = next(e for e in events if e.title == "Film Screening")
    assert screening.time == "18:00"


def test_extract_json_ld_graph():
    events = _extract_json_ld_impl(_GRAPH_EVENT_HTML)
    assert len(events) == 1
    assert events[0].title == "Gallery Opening"


def test_extract_json_ld_empty_html():
    events = _extract_json_ld_impl(_NO_JSON_LD_HTML)
    assert events == []


def test_extract_json_ld_malformed_json_skipped():
    events = _extract_json_ld_impl(_MALFORMED_JSON_HTML)
    assert events == []


def test_extract_json_ld_missing_start_date_skipped():
    html = """<script type="application/ld+json">{"@type": "Event", "name": "Mystery"}</script>"""
    events = _extract_json_ld_impl(html)
    assert events == []


def test_extract_json_ld_missing_name_skipped():
    html = """<script type="application/ld+json">{"@type": "Event", "startDate": "2026-08-01"}</script>"""
    events = _extract_json_ld_impl(html)
    assert events == []


def test_extract_json_ld_non_event_type_skipped():
    html = """<script type="application/ld+json">{"@type": "Organization", "name": "Museum"}</script>"""
    events = _extract_json_ld_impl(html)
    assert events == []


def test_extract_json_ld_offers_price():
    events = _extract_json_ld_impl(_OFFERS_HTML)
    assert len(events) == 1
    assert events[0].price == "15"


def test_extract_json_ld_event_series_type():
    html = """<script type="application/ld+json">
    {"@type": "EventSeries", "name": "Monthly Jazz", "startDate": "2026-11-01"}
    </script>"""
    events = _extract_json_ld_impl(html)
    assert len(events) == 1
    assert events[0].title == "Monthly Jazz"


def test_extract_json_ld_no_time_when_date_only():
    html = """<script type="application/ld+json">
    {"@type": "Event", "name": "All Day Event", "startDate": "2026-09-01"}
    </script>"""
    events = _extract_json_ld_impl(html)
    assert events[0].time is None


# ── navigate_to_events ────────────────────────────────────────────────────────


@patch("agents.scraper_tools.httpx.get")
def test_navigate_returns_first_valid_path(mock_get):
    def side_effect(url, **kwargs):
        if url.endswith("/events"):
            resp = MagicMock(spec=httpx.Response)
            resp.status_code = 200
            resp.text = "Upcoming events and calendar for 2026"
            return resp
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 404
        resp.text = ""
        return resp

    mock_get.side_effect = side_effect
    result = navigate_to_events.func("https://example.com")
    assert result == "https://example.com/events"


@patch("agents.scraper_tools.httpx.get")
def test_navigate_skips_non_200(mock_get):
    resp_404 = MagicMock(spec=httpx.Response)
    resp_404.status_code = 404
    resp_404.text = ""

    resp_200 = MagicMock(spec=httpx.Response)
    resp_200.status_code = 200
    resp_200.text = "calendar of upcoming events"

    call_count = 0

    def side_effect(url, **kwargs):
        nonlocal call_count
        call_count += 1
        if url.endswith("/calendar"):
            return resp_200
        return resp_404

    mock_get.side_effect = side_effect
    result = navigate_to_events.func("https://example.com")
    assert result == "https://example.com/calendar"


@patch("agents.scraper_tools.httpx.get")
def test_navigate_skips_200_without_keywords(mock_get):
    def side_effect(url, **kwargs):
        if url.endswith("/events"):
            resp = MagicMock(spec=httpx.Response)
            resp.status_code = 200
            resp.text = "Welcome to our website"  # no event keywords
            return resp
        if url.endswith("/calendar"):
            resp = MagicMock(spec=httpx.Response)
            resp.status_code = 200
            resp.text = "Check our upcoming events calendar"
            return resp
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 404
        resp.text = ""
        return resp

    mock_get.side_effect = side_effect
    result = navigate_to_events.func("https://example.com")
    assert result == "https://example.com/calendar"


@patch("agents.scraper_tools.httpx.get")
def test_navigate_all_fail_returns_empty(mock_get):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = 404
    resp.text = ""
    mock_get.return_value = resp
    result = navigate_to_events.func("https://example.com")
    assert result == ""


@patch("agents.scraper_tools.httpx.get")
def test_navigate_http_error_continues(mock_get):
    def side_effect(url, **kwargs):
        if "/events" in url and "calendar" not in url and "visit" not in url:
            raise httpx.HTTPError("connection refused")
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.text = "upcoming events calendar"
        return resp

    mock_get.side_effect = side_effect
    result = navigate_to_events.func("https://example.com")
    assert result != ""  # some path succeeded


# ── fetch_page ────────────────────────────────────────────────────────────────


@patch("agents.scraper_tools.httpx.get")
def test_fetch_page_calls_jina_url(mock_get):
    mock_get.return_value = _mock_http_response("# Page content")
    fetch_page.func("https://example.com/events")
    call_url = mock_get.call_args[0][0]
    assert call_url == "https://r.jina.ai/https://example.com/events"


@patch("agents.scraper_tools.httpx.get")
def test_fetch_page_includes_auth_header(mock_get):
    mock_get.return_value = _mock_http_response("# Content")
    fetch_page.func("https://example.com")
    headers = mock_get.call_args[1].get("headers", {})
    assert "Authorization" in headers
    assert headers["Authorization"].startswith("Bearer ")


@patch("agents.scraper_tools.httpx.get")
def test_fetch_page_returns_text(mock_get):
    mock_get.return_value = _mock_http_response("# Markdown content here")
    result = fetch_page.func("https://example.com")
    assert result == "# Markdown content here"


@patch("agents.scraper_tools.httpx.get")
def test_fetch_page_raises_fetch_error_on_http_failure(mock_get):
    mock_get.side_effect = httpx.HTTPError("timeout")
    with pytest.raises(FetchError):
        fetch_page.func("https://example.com")


# ── _extract_events_llm_impl ──────────────────────────────────────────────────


def _mock_llm_response(content: str):
    response = MagicMock()
    response.content = content
    return response


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_returns_events(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.return_value = _mock_llm_response(
        json.dumps([
            {"title": "Piano Night", "date": FUTURE, "time": "20:00"},
            {"title": "Art Walk", "date": FUTURE},
        ])
    )
    events = _extract_events_llm_impl("<html>page</html>", "The Museum", "Austin")
    assert len(events) == 2
    assert events[0].source_strategy == "llm_extract"
    assert events[0].venue_id == ""
    assert events[1].title == "Art Walk"


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_malformed_json_returns_empty(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.return_value = _mock_llm_response("not json at all")
    events = _extract_events_llm_impl("page", "Venue", "City")
    assert events == []


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_non_list_json_returns_empty(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.return_value = _mock_llm_response('{"title": "Event"}')
    events = _extract_events_llm_impl("page", "Venue", "City")
    assert events == []


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_exception_returns_empty(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.side_effect = Exception("API error")
    events = _extract_events_llm_impl("page", "Venue", "City")
    assert events == []


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_skips_items_missing_title_or_date(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.return_value = _mock_llm_response(
        json.dumps([
            {"title": "Good Event", "date": FUTURE},
            {"title": "No Date"},
            {"date": FUTURE},
        ])
    )
    events = _extract_events_llm_impl("page", "Venue", "City")
    assert len(events) == 1
    assert events[0].title == "Good Event"


@patch("agents.scraper_tools.ChatOpenAI")
def test_llm_extract_skips_bad_date_format(mock_cls):
    mock_llm = MagicMock()
    mock_cls.return_value = mock_llm
    mock_llm.invoke.return_value = _mock_llm_response(
        json.dumps([{"title": "Event", "date": "next Friday"}])
    )
    events = _extract_events_llm_impl("page", "Venue", "City")
    assert events == []


# ── _search_web_impl ──────────────────────────────────────────────────────────


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_returns_events(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.return_value = {
        "results": [
            {"title": "Jazz Festival", "url": "https://example.com/jazz", "content": "A jazz event"},
            {"title": "Art Show", "url": "https://example.com/art", "content": "Gallery event"},
        ]
    }
    events = _search_web_impl("Jazz Club events Austin May 2026")
    assert len(events) == 2
    assert events[0].title == "Jazz Festival"
    assert events[0].source_strategy == "search"
    assert events[0].venue_id == ""


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_max_5_results(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.return_value = {
        "results": [{"title": f"Event {i}", "url": f"https://ex.com/{i}", "content": "event"} for i in range(10)]
    }
    events = _search_web_impl("query")
    # We pass max_results=5 to Tavily; it returns at most 5
    mock_client.search.assert_called_once_with("query", max_results=5)


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_empty_results(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.return_value = {"results": []}
    events = _search_web_impl("query")
    assert events == []


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_exception_returns_empty(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.side_effect = Exception("API error")
    events = _search_web_impl("query")
    assert events == []


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_parses_published_date(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.return_value = {
        "results": [
            {
                "title": "Summer Gala",
                "url": "https://example.com",
                "content": "Annual event",
                "published_date": "2026-07-04",
            }
        ]
    }
    events = _search_web_impl("query")
    assert events[0].date == "2026-07-04"


@patch("agents.scraper_tools.TavilyClient")
def test_search_web_skips_titleless_results(mock_cls):
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_client.search.return_value = {
        "results": [
            {"title": "", "url": "https://example.com", "content": "no title"},
        ]
    }
    events = _search_web_impl("query")
    assert events == []
