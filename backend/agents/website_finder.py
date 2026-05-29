"""
Website Finder — discovers the official website for a venue that has no OSM website field.

Strategy:
  1. Tavily search: '"venue_name" city official website'
  2. Filter out aggregators / social media from results
  3. Single LLM call to pick the most likely official URL from the candidates
  4. Return URL string or None. Never raises.
"""

from __future__ import annotations

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from tavily import TavilyClient

import config
from models.types import Venue

_MODEL = "openai/gpt-4o-mini"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Domains that are never official venue websites
_BLOCKLIST = {
    "facebook.com", "instagram.com", "twitter.com", "x.com",
    "yelp.com", "tripadvisor.com", "google.com", "maps.google.com",
    "wikipedia.org", "wikimedia.org", "eventbrite.com", "meetup.com",
    "timeout.com", "yelp.ca", "foursquare.com", "yellowpages.com",
}

_SYSTEM = (
    "You are finding the official website of a cultural venue.\n"
    "Given a list of search result URLs and snippets, pick the single most likely "
    "official website (not Yelp, TripAdvisor, Facebook, Wikipedia, or aggregators).\n"
    "Return ONLY a JSON object: {\"url\": \"https://...\"}\n"
    "If none of the results look like an official website, return: {\"url\": null}\n"
    "No markdown, no explanation."
)


def find(venue: Venue) -> str | None:
    """Return the official website URL for a venue, or None if not found."""
    if not config.TAVILY_API_KEY:
        return None

    query = f'"{venue.name}" {venue.city} official website'
    try:
        client = TavilyClient(api_key=config.TAVILY_API_KEY)
        response = client.search(query, max_results=5)
    except Exception:
        return None

    candidates = _filter_results(response.get("results", []))
    if not candidates:
        return None

    # If only one clean candidate, trust it without an LLM call
    if len(candidates) == 1:
        return candidates[0]["url"]

    return _llm_pick(venue, candidates)


def _filter_results(results: list[dict]) -> list[dict]:
    """Remove aggregator / social media results."""
    clean = []
    for r in results:
        url = r.get("url", "")
        if not url.startswith("http"):
            continue
        domain = _extract_domain(url)
        if any(blocked in domain for blocked in _BLOCKLIST):
            continue
        clean.append({"url": url, "title": r.get("title", ""), "snippet": r.get("content", "")[:200]})
    return clean


def _extract_domain(url: str) -> str:
    match = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return match.group(1).lower() if match else ""


def _llm_pick(venue: Venue, candidates: list[dict]) -> str | None:
    if not config.OPENROUTER_API_KEY:
        return candidates[0]["url"] if candidates else None

    lines = "\n".join(
        f"- {c['url']} | {c['title']} | {c['snippet']}"
        for c in candidates
    )
    prompt = f"Venue: {venue.name} in {venue.city}\n\nSearch results:\n{lines}"

    try:
        llm = ChatOpenAI(
            model=_MODEL,
            api_key=config.OPENROUTER_API_KEY,
            base_url=_OPENROUTER_BASE,
            temperature=0,
        )
        response = llm.invoke([
            SystemMessage(content=_SYSTEM),
            HumanMessage(content=prompt),
        ])
        data = json.loads(response.content.strip())
        url = data.get("url")
        return str(url) if url and str(url).startswith("http") else None
    except Exception:
        return candidates[0]["url"] if candidates else None
