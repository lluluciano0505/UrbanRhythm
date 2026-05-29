"""
M04 — Scraper Tools
Independently callable @tool functions used by the Scraper Agent (M05).
Each tool does exactly one thing and returns a serialized result.

Tools that return events produce JSON strings (list of event dicts) so that
LangChain ToolMessages are readable by both the LLM and M05's collection step.
Internal _impl functions return typed list[RawEvent] and are tested directly.

Dependencies: Jina Reader API, icalendar, OpenRouter/GPT-4o-mini, Tavily.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Optional

import httpx
from icalendar import Calendar
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from tavily import TavilyClient

import config
from models.types import RawEvent


class FetchError(Exception):
    """Raised by fetch_page and parse_ical on HTTP failure or timeout."""


_JINA_URL = "https://r.jina.ai/"
_JINA_TIMEOUT = 30.0
_NAVIGATE_TIMEOUT = 10.0

_NAVIGATE_PATHS = [
    "/events",
    "/calendar",
    "/whats-on",
    "/what's-on",
    "/exhibitions",
    "/programs",
    "/visit/events",
    "/about/events",
]
_NAVIGATE_KEYWORDS = {"event", "calendar", "exhibition", "programme", "upcoming"}

_CLOUDFLARE_MARKERS = (
    "just a moment",
    "checking your browser",
    "enable javascript and cookies to continue",
    "cf-browser-verification",
    "ray id:",
    "cloudflare to restrict access",
)


# ── fetch_page ────────────────────────────────────────────────────────────────


@tool
def fetch_page(url: str) -> str:
    """Download a URL via Jina Reader API and return clean markdown text. Returns empty string on failure or Cloudflare block."""
    jina_url = _JINA_URL + url
    headers = {"Authorization": f"Bearer {config.JINA_API_KEY}"} if config.JINA_API_KEY else {}
    try:
        resp = httpx.get(
            jina_url,
            headers=headers,
            timeout=_JINA_TIMEOUT,
        )
        resp.raise_for_status()
        text = resp.text
        text_lower = text.lower()
        if any(marker in text_lower for marker in _CLOUDFLARE_MARKERS):
            return ""
        return text
    except httpx.HTTPError:
        return ""


# ── find_ical_feed ────────────────────────────────────────────────────────────


@tool
def find_ical_feed(html: str) -> str:
    """Scan page content for iCal feed URLs (.ics, ical, calendar, webcal).
    Works on markdown (from Jina) or raw HTML. Returns JSON array of URLs."""
    return json.dumps(_find_ical_urls(html))


def _find_ical_urls(text: str) -> list[str]:
    md_urls = re.findall(r"\[[^\]]*\]\(((?:https?|webcal)://[^\)\s]+)\)", text)
    http_urls = re.findall(r"https?://[^\s<>\"'()\[\]]+", text)
    webcal_urls = re.findall(r"webcal://[^\s<>\"'()\[\]]+", text)

    all_urls = list(set(md_urls + http_urls + webcal_urls))
    keywords = {".ics", "ical", "calendar", "webcal"}
    return [u for u in all_urls if any(k in u.lower() for k in keywords)]


# ── parse_ical ────────────────────────────────────────────────────────────────


@tool
def parse_ical(url: str) -> str:
    """Download and parse an iCal (.ics) feed. Returns JSON array of upcoming events, or [] on failure."""
    try:
        return json.dumps([_event_to_dict(e) for e in _parse_ical_impl(url)])
    except (FetchError, Exception):
        return "[]"


def _parse_ical_impl(url: str) -> list[RawEvent]:
    try:
        resp = httpx.get(url, timeout=30.0, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise FetchError(f"Failed to fetch iCal feed {url}: {exc}") from exc

    cal = Calendar.from_ical(resp.content)
    today = date.today()
    events: list[RawEvent] = []

    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        dtstart = component.get("DTSTART")
        if not dtstart:
            continue

        raw_dt = dtstart.dt
        if isinstance(raw_dt, datetime):
            event_time: Optional[str] = raw_dt.strftime("%H:%M")
            event_date = raw_dt.date()
        elif isinstance(raw_dt, date):
            event_time = None
            event_date = raw_dt
        else:
            continue

        if event_date < today:
            continue

        title = str(component.get("SUMMARY", "")).strip()
        if not title:
            continue

        desc = component.get("DESCRIPTION")
        url_prop = component.get("URL")

        events.append(
            RawEvent(
                title=title,
                date=event_date.strftime("%Y-%m-%d"),
                time=event_time,
                description=str(desc) if desc else None,
                url=str(url_prop) if url_prop else None,
                price=None,
                venue_id="",
                source_strategy="ical",
            )
        )

    return events


# ── extract_json_ld ───────────────────────────────────────────────────────────


@tool
def extract_json_ld(html: str) -> str:
    """Extract Event objects from JSON-LD script tags in HTML.
    Returns JSON array of events."""
    return json.dumps([_event_to_dict(e) for e in _extract_json_ld_impl(html)])


def _extract_json_ld_impl(html: str) -> list[RawEvent]:
    pattern = r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>'
    matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)
    events: list[RawEvent] = []

    for match in matches:
        try:
            data = json.loads(match.strip())
        except json.JSONDecodeError:
            continue

        if isinstance(data, dict):
            items = data.get("@graph", [data])
        elif isinstance(data, list):
            items = data
        else:
            continue

        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("@type") not in ("Event", "EventSeries"):
                continue
            event = _parse_json_ld_event(item)
            if event:
                events.append(event)

    return events


def _parse_json_ld_event(item: dict) -> Optional[RawEvent]:
    title = item.get("name", "").strip()
    if not title:
        return None

    start = item.get("startDate", "")
    if not start:
        return None

    date_match = re.match(r"(\d{4}-\d{2}-\d{2})", start)
    if not date_match:
        return None
    event_date = date_match.group(1)

    time_match = re.search(r"T(\d{2}:\d{2})", start)
    event_time = time_match.group(1) if time_match else None

    desc = item.get("description") or None
    url = item.get("url") or None

    price: Optional[str] = None
    offers = item.get("offers")
    if isinstance(offers, dict):
        raw_price = offers.get("price")
        price = str(raw_price) if raw_price is not None else None
    elif isinstance(offers, list) and offers:
        raw_price = offers[0].get("price")
        price = str(raw_price) if raw_price is not None else None

    return RawEvent(
        title=title,
        date=event_date,
        time=event_time,
        description=desc,
        url=url,
        price=price,
        venue_id="",
        source_strategy="json_ld",
    )


# ── navigate_to_events ────────────────────────────────────────────────────────


@tool
def navigate_to_events(base_url: str) -> str:
    """Try common events paths on a website using direct HTTP requests.
    Returns the first events page URL found, or empty string if all fail."""
    for path in _NAVIGATE_PATHS:
        url = base_url.rstrip("/") + path
        try:
            resp = httpx.get(url, timeout=_NAVIGATE_TIMEOUT, follow_redirects=True)
            if resp.status_code == 200:
                text_lower = resp.text.lower()
                if any(kw in text_lower for kw in _NAVIGATE_KEYWORDS):
                    return url
        except httpx.HTTPError:
            continue
    return ""


# ── extract_events_llm ────────────────────────────────────────────────────────


_EXTRACTION_SYSTEM_PROMPT = (
    "You are an event data extractor. Extract all upcoming events from the page text.\n"
    "The page text begins with 'Today\\'s date: YYYY-MM-DD' — use this to infer the correct year "
    "for any events that show only a month and day.\n"
    "Return ONLY a JSON array (no other text) where each element has:\n"
    "- title (string, required)\n"
    "- date (YYYY-MM-DD format, required)\n"
    "- time (HH:MM format, optional)\n"
    "- description (string, optional)\n"
    "- url (string, optional)\n\n"
    "If no events are found, return []. No markdown, no explanation — only raw JSON."
)


@tool
def extract_events_llm(html: str, venue_name: str, city: str) -> str:
    """Extract events from page text using GPT-4o-mini via OpenRouter.
    Returns JSON array of events."""
    return json.dumps(
        [_event_to_dict(e) for e in _extract_events_llm_impl(html, venue_name, city)]
    )


def _extract_events_llm_impl(html: str, venue_name: str, city: str) -> list[RawEvent]:
    if not config.OPENROUTER_API_KEY:
        return []

    llm = ChatOpenAI(
        model="openai/gpt-4o-mini",
        api_key=config.OPENROUTER_API_KEY,
        base_url="https://openrouter.ai/api/v1",
        temperature=0,
    )

    today_str = date.today().isoformat()
    page_text = f"Today's date: {today_str}\n\n" + html[:8000]
    messages = [
        SystemMessage(content=_EXTRACTION_SYSTEM_PROMPT),
        HumanMessage(
            content=f"Venue: {venue_name} in {city}\n\nPage content:\n{page_text}"
        ),
    ]

    try:
        response = llm.invoke(messages)
        raw = response.content.strip()
        data = json.loads(raw)
        if not isinstance(data, list):
            return []
    except Exception:
        return []

    events: list[RawEvent] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        title = item.get("title", "").strip()
        event_date = item.get("date", "").strip()
        if not title or not event_date:
            continue
        if not re.match(r"\d{4}-\d{2}-\d{2}", event_date):
            continue
        events.append(
            RawEvent(
                title=title,
                date=event_date,
                time=item.get("time"),
                description=item.get("description"),
                url=item.get("url"),
                price=None,
                venue_id="",
                source_strategy="llm_extract",
            )
        )
    return events


# ── find_event_links ──────────────────────────────────────────────────────────


_LINK_HUNTER_SYSTEM = (
    "You are analyzing a venue website homepage to find where events or activities are listed.\n"
    "Given a list of (link_text, url) pairs extracted from the page, pick the top 3 links most "
    "likely to lead to an events, activities, calendar, or programme listing page.\n"
    "Look for link text like: What's On, Events, Calendar, Season, Programme, Agenda, Exhibitions, "
    "Upcoming, Schedule, Tickets, Shows, Concerts, Performances, Visit, Activities, etc.\n"
    "Prefer internal links (same domain) over external ones.\n"
    "Ignore links to social media, press/media pages, membership, donate, shop, jobs, or staff pages.\n\n"
    "Return ONLY a JSON array of up to 3 objects:\n"
    '[{"url": "https://...", "reason": "link text \'What\\\'s On\' directly suggests event listing"}]\n'
    "No markdown, no explanation — only raw JSON."
)


@tool
def find_event_links(html: str, base_url: str) -> str:
    """Analyze homepage content to find URLs most likely to lead to events or activities pages.
    Pass the markdown from fetch_page and the venue's base URL.
    Returns JSON array of {url, reason} objects, ranked by relevance."""
    if not config.OPENROUTER_API_KEY:
        return "[]"

    # Extract all links from Jina markdown ([text](url) format) and bare URLs
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()

    for text, url in re.findall(r"\[([^\]]*)\]\((https?://[^\)]+)\)", html):
        if url not in seen:
            pairs.append((text.strip(), url))
            seen.add(url)

    if not pairs:
        return "[]"

    # Filter to same-domain links + a few cross-domain for context
    try:
        from urllib.parse import urlparse
        base_host = urlparse(base_url).netloc.lstrip("www.")
        same = [(t, u) for t, u in pairs if base_host in u]
        other = [(t, u) for t, u in pairs if base_host not in u]
        candidates = (same + other)[:60]  # cap to avoid huge prompts
    except Exception:
        candidates = pairs[:60]

    link_lines = "\n".join(f'- "{text}" → {url}' for text, url in candidates)

    llm = ChatOpenAI(
        model="openai/gpt-4o-mini",
        api_key=config.OPENROUTER_API_KEY,
        base_url="https://openrouter.ai/api/v1",
        temperature=0,
    )

    try:
        response = llm.invoke([
            SystemMessage(content=_LINK_HUNTER_SYSTEM),
            HumanMessage(content=f"Venue base URL: {base_url}\n\nLinks found on homepage:\n{link_lines}"),
        ])
        data = json.loads(response.content.strip())
        if not isinstance(data, list):
            return "[]"
        # Validate structure
        result = [
            {"url": item["url"], "reason": item.get("reason", "")}
            for item in data
            if isinstance(item, dict) and "url" in item
        ]
        return json.dumps(result)
    except Exception:
        return "[]"


# ── search_web ────────────────────────────────────────────────────────────────


@tool
def search_web(query: str) -> str:
    """Search the web for venue events using Tavily. Returns JSON array of events."""
    return json.dumps([_event_to_dict(e) for e in _search_web_impl(query)])


def _search_web_impl(query: str) -> list[RawEvent]:
    if not config.TAVILY_API_KEY:
        return []
    client = TavilyClient(api_key=config.TAVILY_API_KEY)
    try:
        response = client.search(query, max_results=5)
    except Exception:
        return []

    today = date.today().isoformat()
    events: list[RawEvent] = []
    for r in response.get("results", []):
        title = r.get("title", "").strip()
        if not title:
            continue
        url = r.get("url") or None
        description = r.get("content") or None

        event_date = today
        pub_date = r.get("published_date", "")
        if pub_date:
            date_match = re.match(r"(\d{4}-\d{2}-\d{2})", pub_date)
            if date_match:
                event_date = date_match.group(1)

        events.append(
            RawEvent(
                title=title,
                date=event_date,
                time=None,
                description=description[:300] if description else None,
                url=url,
                price=None,
                venue_id="",
                source_strategy="search",
            )
        )
    return events


# ── Exported tool list (used by M05) ─────────────────────────────────────────

ALL_TOOLS = [
    fetch_page,
    find_ical_feed,
    parse_ical,
    extract_json_ld,
    find_event_links,
    navigate_to_events,
    extract_events_llm,
    search_web,
]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _event_to_dict(event: RawEvent) -> dict:
    return {
        "title": event.title,
        "date": event.date,
        "time": event.time,
        "description": event.description,
        "url": event.url,
        "price": event.price,
        "venue_id": event.venue_id,
        "source_strategy": event.source_strategy,
    }
