"""Tests for M07 — Judge Agent. LLM calls are mocked; DB uses in-memory SQLite."""

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

import data.database as db
from agents.judge_agent import _llm_score, _rule_score, _verdict, judge
from models.types import JudgedEvent, RawEvent, Venue

FUTURE = (date.today() + timedelta(days=30)).strftime("%Y-%m-%d")
TODAY = date.today().isoformat()
PAST = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")

VENUE = Venue(
    id="osm_node_1",
    name="Jazz Club",
    type="arts_centre",
    city="Austin",
    country="US",
    lat=30.27,
    lon=-97.74,
    osm_id="1",
)


@pytest.fixture(autouse=True)
def fresh_db():
    db.init_db(":memory:")
    db.upsert_venue(VENUE)


def _event(
    title: str = "Jazz Night",
    event_date: str = None,
    description: str = "A great show",
    url: str = "https://example.com/event",
    venue_id: str = "osm_node_1",
) -> RawEvent:
    return RawEvent(
        title=title,
        date=event_date or FUTURE,
        venue_id=venue_id,
        source_strategy="ical",
        description=description,
        url=url,
    )


# ── _rule_score ───────────────────────────────────────────────────────────────


def test_rule_score_future_adds_035():
    e = _event(event_date=FUTURE, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.35 + 0.25 + 0.20)


def test_rule_score_past_no_future_points():
    e = _event(event_date=PAST, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.25 + 0.20)


def test_rule_score_desc_adds_020():
    e = _event(event_date=PAST, description="A show", url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.25 + 0.20 + 0.20)


def test_rule_score_url_adds_020():
    e = _event(event_date=PAST, description=None, url="https://example.com")
    assert _rule_score(e, TODAY) == pytest.approx(0.25 + 0.20 + 0.20)


def test_rule_score_venue_always_contributes():
    e = _event(title="Event", event_date=PAST, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.20)


def test_rule_score_generic_title_tbd_no_points():
    e = _event(title="TBD", event_date=PAST, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.20)


def test_rule_score_generic_title_coming_soon_no_points():
    e = _event(title="Coming Soon", event_date=PAST, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.20)


def test_rule_score_short_title_no_points():
    e = _event(title="Show", event_date=PAST, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.20)


def test_rule_score_today_is_future():
    e = _event(event_date=TODAY, description=None, url=None)
    assert _rule_score(e, TODAY) == pytest.approx(0.35 + 0.25 + 0.20)


def test_rule_score_max_all_criteria():
    e = _event(event_date=FUTURE, description="Great show", url="https://x.com")
    assert _rule_score(e, TODAY) == pytest.approx(1.0)


# ── _verdict ──────────────────────────────────────────────────────────────────


def test_verdict_accept_at_threshold():
    assert _verdict(0.65) == "accept"


def test_verdict_accept_above_threshold():
    assert _verdict(1.0) == "accept"
    assert _verdict(0.80) == "accept"


def test_verdict_review_at_lower_bound():
    assert _verdict(0.35) == "review"


def test_verdict_review_in_middle():
    assert _verdict(0.50) == "review"


def test_verdict_review_just_below_accept():
    assert _verdict(0.6499) == "review"


def test_verdict_reject_zero():
    assert _verdict(0.0) == "reject"


def test_verdict_reject_low():
    assert _verdict(0.20) == "reject"


def test_verdict_reject_just_below_review():
    assert _verdict(0.3499) == "reject"


# ── _llm_score ────────────────────────────────────────────────────────────────


def test_llm_score_returns_refined_float():
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.return_value = MagicMock(content='{"score": 0.85}')
        mock_cls.return_value = mock_llm

        result = _llm_score(_event(), fallback=0.50)
        assert result == pytest.approx(0.85)


def test_llm_score_clamps_above_1():
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.return_value = MagicMock(content='{"score": 1.5}')
        mock_cls.return_value = mock_llm

        result = _llm_score(_event(), fallback=0.50)
        assert result == pytest.approx(1.0)


def test_llm_score_clamps_below_0():
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.return_value = MagicMock(content='{"score": -0.5}')
        mock_cls.return_value = mock_llm

        result = _llm_score(_event(), fallback=0.50)
        assert result == pytest.approx(0.0)


def test_llm_score_returns_fallback_on_api_error():
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.side_effect = Exception("API error")
        mock_cls.return_value = mock_llm

        result = _llm_score(_event(), fallback=0.55)
        assert result == pytest.approx(0.55)


def test_llm_score_returns_fallback_on_bad_json():
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.return_value = MagicMock(content="not json at all")
        mock_cls.return_value = mock_llm

        result = _llm_score(_event(), fallback=0.60)
        assert result == pytest.approx(0.60)


# ── judge() ───────────────────────────────────────────────────────────────────


def test_judge_empty_input_returns_empty():
    assert judge([], "Austin") == []


def test_judge_returns_judged_events():
    result = judge([_event()], "Austin")
    assert len(result) == 1
    assert isinstance(result[0], JudgedEvent)


def test_judge_max_score_event_is_accepted():
    e = _event(event_date=FUTURE, description="Show", url="https://x.com")
    result = judge([e], "Austin")
    assert result[0].quality_score == pytest.approx(1.0)
    assert result[0].verdict == "accept"


def test_judge_past_minimal_event_is_rejected():
    e = _event(title="Event", event_date=PAST, description=None, url=None)
    result = judge([e], "Austin")
    assert result[0].verdict == "reject"


def test_judge_calls_llm_for_borderline_score():
    # score = 0.20 (venue) + 0.25 (non-generic) + 0.20 (desc) = 0.65 — in [0.40, 0.70]
    e = _event(event_date=PAST, description="A show", url=None)
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        mock_llm = MagicMock()
        mock_llm.invoke.return_value = MagicMock(content='{"score": 0.9}')
        mock_cls.return_value = mock_llm

        result = judge([e], "Austin")

    mock_llm.invoke.assert_called_once()
    assert result[0].quality_score == pytest.approx(0.9)
    assert result[0].verdict == "accept"


def test_judge_no_llm_for_score_above_band():
    # score = 1.0 (all criteria met) — above 0.70, no LLM
    e = _event(event_date=FUTURE, description="Show", url="https://x.com")
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        judge([e], "Austin")
        mock_cls.assert_not_called()


def test_judge_no_llm_for_score_below_band():
    # score = 0.20 (generic title, past, no desc/url) — below 0.40, no LLM
    e = _event(title="Event", event_date=PAST, description=None, url=None)
    with patch("agents.judge_agent.ChatOpenAI") as mock_cls:
        judge([e], "Austin")
        mock_cls.assert_not_called()


def test_judge_upserts_to_db():
    judge([_event()], "Austin")
    rows = db.get_events(city="Austin")
    assert len(rows) == 1
    assert rows[0]["title"] == "Jazz Night"


def test_judge_sets_judged_at():
    result = judge([_event()], "Austin")
    assert result[0].judged_at is not None
    assert isinstance(result[0].judged_at, datetime)


def test_judge_multiple_events_all_returned():
    events = [
        _event(title="Jazz Night", event_date=FUTURE),
        _event(title="Art Exhibition Opening Night", event_date=FUTURE),
    ]
    result = judge(events, "Austin")
    assert len(result) == 2


def test_judge_idempotent_upsert():
    e = _event()
    judge([e], "Austin")
    judge([e], "Austin")
    rows = db.get_events(city="Austin")
    assert len(rows) == 1


def test_judge_preserves_all_raw_fields():
    e = _event(title="Jazz Night", event_date=FUTURE, description="A show", url="https://x.com")
    result = judge([e], "Austin")
    j = result[0]
    assert j.title == "Jazz Night"
    assert j.date == FUTURE
    assert j.description == "A show"
    assert j.url == "https://x.com"
    assert j.venue_id == "osm_node_1"
    assert j.source_strategy == "ical"
