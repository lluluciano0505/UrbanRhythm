"""
Extractor Agent — parallel mini ReAct agents, one per target URL.
Each agent: fetch page → find iCal OR extract via LLM. Max 4 tool calls each.
Results are merged and deduplicated by (title, date).
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

import config
from agents.scraper_tools import extract_events_llm, fetch_page, find_ical_feed, parse_ical
from models.types import RawEvent

_MODEL = "openai/gpt-4o-mini"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_TOOLS = [fetch_page, find_ical_feed, parse_ical, extract_events_llm]
_MAX_TOOL_CALLS = 4
_RECURSION_LIMIT = _MAX_TOOL_CALLS * 2 + 1

_SYSTEM = """\
You are extracting events from a specific page at {venue_name} ({city}).
Today: {today}. Target URL: {target_url}

Steps:
1. fetch_page({target_url})
2. find_ical_feed on the content — if a feed URL appears, parse_ical(feed_url)
3. Otherwise extract_events_llm(page_content, "{venue_name}", "{city}")

Stop immediately once you have events. Only return future events (date >= {today}).\
"""


def _scrape_one_url(url: str, venue_name: str, city: str, venue_id: str) -> list[RawEvent]:
    """Run a focused mini-agent on a single URL. Never raises."""
    if not config.OPENROUTER_API_KEY:
        return []

    today = date.today().isoformat()
    system = _SYSTEM.format(
        venue_name=venue_name, city=city, today=today, target_url=url
    )

    try:
        llm = ChatOpenAI(
            model=_MODEL,
            api_key=config.OPENROUTER_API_KEY,
            base_url=_OPENROUTER_BASE,
            temperature=0,
        )
        agent = create_react_agent(llm, _TOOLS, prompt=system)
        result = agent.invoke(
            {"messages": [{"role": "user", "content": f"Extract events from {url}"}]},
            config={"recursion_limit": _RECURSION_LIMIT},
        )
        return _collect(result.get("messages", []), venue_id, today)
    except Exception:
        return []


def _collect(messages: list, venue_id: str, today: str) -> list[RawEvent]:
    events: list[RawEvent] = []
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        try:
            data = json.loads(msg.content)
            if not isinstance(data, list):
                continue
            for item in data:
                if not isinstance(item, dict):
                    continue
                title = item.get("title", "").strip()
                d = item.get("date", "").strip()
                if title and d and d >= today:
                    events.append(RawEvent(
                        title=title,
                        date=d,
                        venue_id=venue_id,
                        source_strategy="thorough_extract",
                        time=item.get("time"),
                        description=item.get("description"),
                        url=item.get("url"),
                    ))
        except Exception:
            continue
    return events


def extract_all(
    target_urls: list[str],
    venue_name: str,
    city: str,
    venue_id: str,
    max_concurrency: int = 3,
) -> list[RawEvent]:
    """Fan out to target_urls in parallel. Returns merged deduplicated future events."""
    if not target_urls:
        return []

    all_events: list[RawEvent] = []
    with ThreadPoolExecutor(max_workers=max_concurrency) as pool:
        futures = {
            pool.submit(_scrape_one_url, url, venue_name, city, venue_id): url
            for url in target_urls
        }
        for future in as_completed(futures):
            try:
                all_events.extend(future.result())
            except Exception:
                pass

    # Deduplicate by (title, date)
    seen: set[tuple[str, str]] = set()
    deduped: list[RawEvent] = []
    for e in all_events:
        key = (e.title.lower().strip(), e.date)
        if key not in seen:
            seen.add(key)
            deduped.append(e)

    return deduped
