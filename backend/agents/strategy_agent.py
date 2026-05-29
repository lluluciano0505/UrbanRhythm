"""
Strategy Agent — ranks candidate URLs from a SiteProfile.
Single LLM call. Input: SiteProfile. Output: ordered list[str] of target URLs (max 5).
"""

from __future__ import annotations

import json

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

import config
from models.types import SiteProfile

_MODEL = "openai/gpt-4o-mini"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

_SYSTEM = (
    "You are deciding which URLs to scrape to find upcoming events at a venue.\n"
    "Given a site profile with candidate links, return an ordered list of up to 5 target URLs.\n\n"
    "Return ONLY a JSON array — no markdown, no explanation:\n"
    '[\n  {"url": "https://...", "priority": 1, "reason": "..."},\n  ...\n]\n\n'
    "Priority 1 = most likely to contain event listings.\n"
    "Prefer: /events, /calendar, /whats-on, /programme, /season/2025, /agenda, /exhibitions/upcoming\n"
    "Deprioritize: /about, /press, /shop, /membership, /donate, /contact, /staff\n"
    "If the site has iCal, include the iCal feed URL as priority 1.\n"
    "Return empty array [] if no candidate links were provided."
)


_COMMON_EVENT_PATHS = [
    "/events", "/calendar", "/whats-on", "/what-s-on",
    "/programmes", "/program", "/programs",
    "/visit/events", "/visit/whats-on",
    "/exhibitions/upcoming", "/schedule", "/agenda",
]


def _guess_common_paths(base_url: str) -> list[str]:
    """Build guessed event URLs from common paths on the venue's domain."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(base_url)
        root = f"{parsed.scheme}://{parsed.netloc}"
        return [root + p for p in _COMMON_EVENT_PATHS][:5]
    except Exception:
        return []


def plan(site_profile: SiteProfile, base_url: str) -> list[str]:
    """Return ordered list of URLs to scrape. Never raises. Falls back to candidate_links order."""
    if not site_profile.candidate_links:
        # Navigator found no links — fall back to guessing common event paths
        return _guess_common_paths(base_url) if base_url else []

    if not config.OPENROUTER_API_KEY:
        return site_profile.candidate_links[:5]

    llm = ChatOpenAI(
        model=_MODEL,
        api_key=config.OPENROUTER_API_KEY,
        base_url=_OPENROUTER_BASE,
        temperature=0,
    )

    profile_text = (
        f"Base URL: {base_url}\n"
        f"CMS: {site_profile.cms or 'unknown'}\n"
        f"Language: {site_profile.language}\n"
        f"Depth estimate: {site_profile.depth_estimate}\n"
        f"Has pagination: {site_profile.has_pagination}\n"
        f"Has iCal: {site_profile.has_ical}\n"
        f"Candidate links:\n" + "\n".join(f"  - {u}" for u in site_profile.candidate_links)
    )

    try:
        response = llm.invoke([
            SystemMessage(content=_SYSTEM),
            HumanMessage(content=profile_text),
        ])
        data = json.loads(response.content.strip())
        if not isinstance(data, list):
            return site_profile.candidate_links[:5]
        data.sort(key=lambda x: x.get("priority", 99) if isinstance(x, dict) else 99)
        return [
            item["url"] for item in data
            if isinstance(item, dict) and "url" in item and str(item["url"]).startswith("http")
        ][:5]
    except Exception:
        return site_profile.candidate_links[:5]
