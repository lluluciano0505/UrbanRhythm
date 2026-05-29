"""
M07 — Judge Agent
Scores raw events with rule-based criteria, with Claude Sonnet LLM refinement for
borderline cases (rule-based score in [0.40, 0.70]). Upserts all events to DB.

Public interface: judge(events, city) -> list[JudgedEvent]
"""

from __future__ import annotations

import json
from datetime import date, datetime

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

import config
import data.database as db
from models.types import JudgedEvent, RawEvent

_SONNET_MODEL = "anthropic/claude-3-5-sonnet"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

_GENERIC_TITLES = {"event", "tbd", "coming soon", ""}

_LLM_SYSTEM_PROMPT = (
    "You are an event quality judge. Score this cultural event on a scale of 0.0 to 1.0.\n"
    "1.0 = clearly a real, specific, upcoming cultural event with good information.\n"
    "0.0 = spam, duplicate, generic filler, or not an actual event.\n"
    "Consider: specificity of title, presence of description, whether it looks like a real event.\n"
    "Return ONLY a JSON object: {\"score\": <float>}\n"
    "No explanation, no markdown — only raw JSON."
)

_LLM_BAND_LOW = 0.40
_LLM_BAND_HIGH = 0.70


def judge(events: list[RawEvent], city: str) -> list[JudgedEvent]:
    """Score and persist all events. Returns judged list."""
    today = date.today().isoformat()
    result: list[JudgedEvent] = []

    for event in events:
        score = _rule_score(event, today)
        if _LLM_BAND_LOW <= score <= _LLM_BAND_HIGH:
            score = _llm_score(event, fallback=score)
        verdict = _verdict(score)
        judged = JudgedEvent(
            title=event.title,
            date=event.date,
            venue_id=event.venue_id,
            source_strategy=event.source_strategy,
            time=event.time,
            description=event.description,
            url=event.url,
            price=event.price,
            quality_score=round(score, 4),
            verdict=verdict,
            judged_at=datetime.utcnow(),
        )
        db.upsert_event(judged, city, run_id=None)
        result.append(judged)

    return result


# ── Rule-based scoring ────────────────────────────────────────────────────────


def _rule_score(event: RawEvent, today: str) -> float:
    score = 0.0
    if event.date >= today:
        score += 0.35
    normalized = event.title.strip().lower()
    if normalized not in _GENERIC_TITLES and len(event.title.strip()) > 5:
        score += 0.25
    score += 0.20  # venue_id always set
    if event.description is not None or event.url is not None:
        score += 0.20
    return round(score, 4)


def _verdict(score: float) -> str:
    if score >= 0.65:
        return "accept"
    if score >= 0.35:
        return "review"
    return "reject"


# ── LLM scoring ───────────────────────────────────────────────────────────────


def _llm_score(event: RawEvent, fallback: float) -> float:
    """Call Claude Sonnet to refine score for a borderline event. Returns fallback on error."""
    llm = ChatOpenAI(
        model=_SONNET_MODEL,
        api_key=config.OPENROUTER_API_KEY,
        base_url=_OPENROUTER_BASE,
        temperature=0,
    )
    content = (
        f"Title: {event.title}\n"
        f"Date: {event.date}\n"
        f"Description: {event.description or 'N/A'}\n"
        f"URL: {event.url or 'N/A'}"
    )
    try:
        response = llm.invoke([
            SystemMessage(content=_LLM_SYSTEM_PROMPT),
            HumanMessage(content=content),
        ])
        data = json.loads(response.content.strip())
        score = float(data["score"])
        return max(0.0, min(1.0, score))
    except Exception:
        return fallback
