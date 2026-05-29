"""
M05 — Scraper Agent
Orchestrates M04 scraper tools in a ReAct loop to extract events from one venue.
Consults M03 Playbook Store at start and records what worked at the end.

Public interface: scrape(venue) -> ScrapeResult
  Always returns — never raises.

Dependencies: M03 (playbook), M04 (tools), LangGraph create_react_agent,
              OpenRouter → GPT-4o-mini.
"""

from __future__ import annotations

import json
from datetime import date
from urllib.parse import urlparse

from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

import config
import data.playbook_store as playbook_store
from agents.scraper_tools import ALL_TOOLS
from models.types import RawEvent, ScrapeResult, Venue

_MODEL = "openai/gpt-4o-mini"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_MAX_TOOL_CALLS = 12
# Each tool call = 1 agent step + 1 tools step → 2 graph transitions.
_RECURSION_LIMIT = _MAX_TOOL_CALLS * 2 + 1

_DEFAULT_ORDER = "ical → json_ld → find_event_links → follow top link → llm_extract → search"

_SYSTEM_PROMPT = """\
You are an event scraper for {venue_name} ({venue_url}) in {city}.
Today's date is {today}.

Goal: find at least one upcoming event (date >= today) at this venue.

Preferred strategy order: {strategy_order}

Step-by-step approach:
1. fetch_page({venue_url}) — get the homepage content.
2. find_ical_feed(homepage) — check for an iCal feed URL.
   - If found: parse_ical(feed_url) → done if events found.
3. extract_json_ld(homepage) — check for JSON-LD Event data.
   - If found: done if events found.
4. find_event_links(homepage, "{venue_url}") — ask the LLM to identify the top 3 links \
most likely to lead to an events or activities listing page (e.g. "What's On", "Programme", "Calendar", "Season 2025").
   - For each returned URL: fetch_page(url), then extract_events_llm(page, venue_name, city).
   - Stop as soon as you find at least one future event.
5. If still nothing: extract_events_llm(homepage, venue_name, city) — try extracting from homepage directly.
6. Last resort: search_web("{search_query}")

Rules:
- Stop immediately once you have at least one future event (date >= today).
- Do not call the same tool twice with the same arguments.
- find_event_links reads the actual link text from the page — use it instead of guessing URLs.
- When calling extract_events_llm, always pass the page text from fetch_page as the html argument.
"""


def scrape(venue: Venue) -> ScrapeResult:
    """Run the ReAct scraping loop for one venue. Always returns ScrapeResult."""
    if not venue.website:
        return ScrapeResult(venue_id=venue.id, success=False, error="no website")

    domain = _extract_domain(venue.website)
    known = playbook_store.get(domain)

    today = date.today().isoformat()
    search_query = f'"{venue.name}" events {venue.city}'

    if known:
        strategy_order = (
            f"{known.strategy} first (known playbook), then fallback: {_DEFAULT_ORDER}"
        )
    else:
        strategy_order = _DEFAULT_ORDER

    system_prompt = _SYSTEM_PROMPT.format(
        venue_name=venue.name,
        venue_url=venue.website,
        city=venue.city,
        today=today,
        strategy_order=strategy_order,
        search_query=search_query,
    )

    try:
        llm = ChatOpenAI(
            model=_MODEL,
            api_key=config.OPENROUTER_API_KEY,
            base_url=_OPENROUTER_BASE,
            temperature=0,
        )
        agent = create_react_agent(llm, ALL_TOOLS, prompt=system_prompt)
        result = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": f"Scrape upcoming events for {venue.name} at {venue.website}",
                    }
                ]
            },
            config={"recursion_limit": _RECURSION_LIMIT},
        )
        messages = result.get("messages", [])
    except Exception as exc:
        return ScrapeResult(venue_id=venue.id, success=False, error=str(exc))

    events = _collect_events(messages, venue.id)
    future_events = [e for e in events if e.date >= today]
    attempts = _count_tool_calls(messages)

    success = len(future_events) > 0
    strategy_used = future_events[0].source_strategy if future_events else None

    if success and strategy_used:
        playbook_store.save(domain, strategy_used, {"discovered_via": strategy_used}, True)
    else:
        playbook_store.save(domain, None, {}, False)

    return ScrapeResult(
        venue_id=venue.id,
        success=success,
        events=future_events,
        strategy_used=strategy_used,
        attempts=attempts,
        error=None if success else "no future events found",
    )


# ── Helpers ───────────────────────────────────────────────────────────────────


def _extract_domain(url: str) -> str:
    """Strip scheme and www. from a URL to get the bare domain."""
    try:
        netloc = urlparse(url).netloc
        if netloc.startswith("www."):
            netloc = netloc[4:]
        return netloc
    except Exception:
        return url


def _collect_events(messages: list, venue_id: str) -> list[RawEvent]:
    """Reconstruct RawEvent objects from ToolMessage JSON content."""
    events: list[RawEvent] = []
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        content = msg.content
        if not isinstance(content, str):
            continue
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            title = item.get("title", "").strip()
            event_date = item.get("date", "").strip()
            if not title or not event_date:
                continue
            events.append(
                RawEvent(
                    title=title,
                    date=event_date,
                    time=item.get("time"),
                    description=item.get("description"),
                    url=item.get("url"),
                    price=item.get("price"),
                    venue_id=venue_id,
                    source_strategy=item.get("source_strategy", "unknown"),
                )
            )
    return events


def _count_tool_calls(messages: list) -> int:
    return sum(1 for msg in messages if isinstance(msg, ToolMessage))
