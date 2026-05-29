"""Tests for M05 — Scraper Agent. Agent loop is mocked; DB uses in-memory SQLite."""

import json
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

import data.database as db
from agents.scraper_agent import _collect_events, _count_tool_calls, _extract_domain, scrape
from models.types import RawEvent, ScrapeResult, Venue

# ── Fixtures ──────────────────────────────────────────────────────────────────

TODAY = date.today().isoformat()
FUTURE = (date.today() + timedelta(days=30)).strftime("%Y-%m-%d")
PAST = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")


@pytest.fixture(autouse=True)
def fresh_db():
    db.init_db(":memory:")


VENUE = Venue(
    id="osm_node_1",
    name="The Jazz Club",
    type="arts_centre",
    city="Austin",
    country="US",
    lat=30.27,
    lon=-97.74,
    osm_id="1",
    website="https://www.jazzclub.example.com/",
)

VENUE_NO_WEBSITE = Venue(
    id="osm_node_2",
    name="Mystery Museum",
    type="museum",
    city="Austin",
    country="US",
    lat=30.27,
    lon=-97.74,
    osm_id="2",
    website=None,
)


def _tool_message(content: str, tool_call_id: str = "call_1") -> MagicMock:
    from langchain_core.messages import ToolMessage
    return ToolMessage(content=content, tool_call_id=tool_call_id)


def _ai_message(content: str = "") -> MagicMock:
    from langchain_core.messages import AIMessage
    return AIMessage(content=content)


def _event_json(
    title: str,
    event_date: str,
    source_strategy: str = "ical",
    venue_id: str = "",
) -> str:
    return json.dumps([
        {
            "title": title,
            "date": event_date,
            "time": None,
            "description": None,
            "url": None,
            "price": None,
            "venue_id": venue_id,
            "source_strategy": source_strategy,
        }
    ])


def _build_mock_agent(messages: list) -> MagicMock:
    mock_agent = MagicMock()
    mock_agent.invoke.return_value = {"messages": messages}
    return mock_agent


# ── _extract_domain ───────────────────────────────────────────────────────────


def test_extract_domain_strips_scheme():
    assert _extract_domain("https://example.com/path") == "example.com"


def test_extract_domain_strips_www():
    assert _extract_domain("https://www.example.com") == "example.com"


def test_extract_domain_http():
    assert _extract_domain("http://example.com") == "example.com"


def test_extract_domain_no_www():
    assert _extract_domain("https://jazzclub.com/events") == "jazzclub.com"


def test_extract_domain_handles_malformed_url():
    result = _extract_domain("not-a-url")
    assert isinstance(result, str)


# ── _collect_events ───────────────────────────────────────────────────────────


def test_collect_events_extracts_from_tool_messages():
    messages = [
        _ai_message("Calling parse_ical"),
        _tool_message(_event_json("Jazz Night", FUTURE, "ical"), "call_1"),
        _ai_message("Found 1 event."),
    ]
    events = _collect_events(messages, "osm_node_1")
    assert len(events) == 1
    assert events[0].title == "Jazz Night"
    assert events[0].date == FUTURE
    assert events[0].source_strategy == "ical"


def test_collect_events_fills_venue_id():
    messages = [_tool_message(_event_json("Concert", FUTURE), "call_1")]
    events = _collect_events(messages, "osm_node_99")
    assert events[0].venue_id == "osm_node_99"


def test_collect_events_multiple_tool_messages():
    messages = [
        _tool_message(json.dumps([]), "call_1"),  # empty tool result
        _tool_message(_event_json("Art Walk", FUTURE, "json_ld"), "call_2"),
    ]
    events = _collect_events(messages, "osm_node_1")
    assert len(events) == 1
    assert events[0].title == "Art Walk"


def test_collect_events_ignores_non_tool_messages():
    messages = [
        _ai_message("Let me search for events."),
        _tool_message(_event_json("Film Night", FUTURE), "call_1"),
        _ai_message("Found it!"),
    ]
    events = _collect_events(messages, "osm_node_1")
    assert len(events) == 1


def test_collect_events_skips_malformed_json():
    from langchain_core.messages import ToolMessage
    messages = [ToolMessage(content="not json", tool_call_id="call_1")]
    events = _collect_events(messages, "osm_node_1")
    assert events == []


def test_collect_events_skips_non_event_json():
    from langchain_core.messages import ToolMessage
    messages = [ToolMessage(content='"https://example.com/feed.ics"', tool_call_id="call_1")]
    events = _collect_events(messages, "osm_node_1")
    assert events == []


def test_collect_events_empty_messages():
    events = _collect_events([], "osm_node_1")
    assert events == []


# ── _count_tool_calls ─────────────────────────────────────────────────────────


def test_count_tool_calls_counts_tool_messages():
    messages = [
        _ai_message(),
        _tool_message("[]", "call_1"),
        _ai_message(),
        _tool_message("[]", "call_2"),
        _ai_message("Done."),
    ]
    assert _count_tool_calls(messages) == 2


def test_count_tool_calls_zero():
    assert _count_tool_calls([_ai_message("No tools used")]) == 0


def test_count_tool_calls_empty_messages():
    assert _count_tool_calls([]) == 0


# ── scrape() — no website ─────────────────────────────────────────────────────


def test_scrape_no_website_returns_failure():
    result = scrape(VENUE_NO_WEBSITE)
    assert isinstance(result, ScrapeResult)
    assert result.success is False
    assert result.error == "no website"
    assert result.venue_id == VENUE_NO_WEBSITE.id


# ── scrape() — successful scrape ──────────────────────────────────────────────


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_success_returns_events(mock_create):
    messages = [
        _ai_message("Calling parse_ical"),
        _tool_message(_event_json("Jazz Night", FUTURE, "ical"), "call_1"),
        _ai_message("Found 1 upcoming event."),
    ]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)

    assert result.success is True
    assert len(result.events) == 1
    assert result.events[0].title == "Jazz Night"
    assert result.events[0].venue_id == VENUE.id
    assert result.strategy_used == "ical"
    assert result.attempts == 1


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_fills_venue_id_on_all_events(mock_create):
    event_json = json.dumps([
        {"title": "Event A", "date": FUTURE, "source_strategy": "json_ld", "venue_id": "", "time": None, "description": None, "url": None, "price": None},
        {"title": "Event B", "date": FUTURE, "source_strategy": "json_ld", "venue_id": "", "time": None, "description": None, "url": None, "price": None},
    ])
    messages = [
        _tool_message(event_json, "call_1"),
        _ai_message("Found 2 events."),
    ]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert all(e.venue_id == VENUE.id for e in result.events)


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_excludes_past_events(mock_create):
    event_json = json.dumps([
        {"title": "Old Show", "date": PAST, "source_strategy": "ical", "venue_id": "", "time": None, "description": None, "url": None, "price": None},
        {"title": "Future Concert", "date": FUTURE, "source_strategy": "ical", "venue_id": "", "time": None, "description": None, "url": None, "price": None},
    ])
    messages = [_tool_message(event_json, "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert result.success is True
    assert len(result.events) == 1
    assert result.events[0].title == "Future Concert"


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_all_past_events_is_failure(mock_create):
    messages = [_tool_message(_event_json("Old Show", PAST), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert result.success is False
    assert result.events == []


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_attempts_counts_tool_calls(mock_create):
    messages = [
        _tool_message(json.dumps([]), "call_1"),
        _tool_message(json.dumps([]), "call_2"),
        _tool_message(_event_json("Concert", FUTURE), "call_3"),
    ]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert result.attempts == 3


# ── scrape() — playbook interactions ─────────────────────────────────────────


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_saves_strategy_on_success(mock_create):
    messages = [_tool_message(_event_json("Concert", FUTURE, "json_ld"), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = None
        scrape(VENUE)
        mock_pb.save.assert_called_once()
        call_args = mock_pb.save.call_args
        assert call_args[0][1] == "json_ld"   # strategy
        assert call_args[0][3] is True        # success=True


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_saves_failure_when_no_events(mock_create):
    messages = [_tool_message(json.dumps([]), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = None
        scrape(VENUE)
        mock_pb.save.assert_called_once()
        call_args = mock_pb.save.call_args
        assert call_args[0][3] is False       # success=False


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_consults_playbook(mock_create):
    from data.playbook_store import Strategy

    known = Strategy(strategy="ical", detail={}, cms_type="wordpress", confidence=0.9)
    messages = [_tool_message(_event_json("Concert", FUTURE, "ical"), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = known
        scrape(VENUE)
        mock_pb.get.assert_called_once_with("jazzclub.example.com")


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_playbook_strategy_in_prompt(mock_create):
    from data.playbook_store import Strategy

    known = Strategy(strategy="ical", detail={}, cms_type=None, confidence=1.0)
    messages = [_tool_message(_event_json("Show", FUTURE, "ical"), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = known
        scrape(VENUE)
        # create_react_agent should have been called with a prompt containing "ical first"
        _, kwargs = mock_create.call_args
        prompt = kwargs.get("prompt", mock_create.call_args[0][2] if len(mock_create.call_args[0]) > 2 else "")
        assert "ical" in prompt.lower()


# ── scrape() — error handling ─────────────────────────────────────────────────


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_never_raises_on_agent_exception(mock_create):
    mock_agent = MagicMock()
    mock_agent.invoke.side_effect = Exception("LangGraph blew up")
    mock_create.return_value = mock_agent

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = None
        result = scrape(VENUE)

    assert isinstance(result, ScrapeResult)
    assert result.success is False
    assert "LangGraph blew up" in result.error


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_returns_scrape_result_type(mock_create):
    messages = [_tool_message(_event_json("Show", FUTURE), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert isinstance(result, ScrapeResult)


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_no_events_error_message(mock_create):
    messages = [_tool_message(json.dumps([]), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    with patch("agents.scraper_agent.playbook_store") as mock_pb:
        mock_pb.get.return_value = None
        result = scrape(VENUE)

    assert result.error == "no future events found"


@patch("agents.scraper_agent.create_react_agent")
def test_scrape_success_error_is_none(mock_create):
    messages = [_tool_message(_event_json("Concert", FUTURE), "call_1")]
    mock_create.return_value = _build_mock_agent(messages)

    result = scrape(VENUE)
    assert result.error is None
