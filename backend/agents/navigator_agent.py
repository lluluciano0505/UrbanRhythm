"""
Navigator Agent — classifies a venue website's structure.
Single LLM call (no tools, no loop). Input: homepage markdown. Output: SiteProfile.
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
    "You are classifying a venue website to help a scraper find events.\n"
    "Analyze the homepage content and return ONLY a JSON object — no markdown, no explanation:\n\n"
    "{\n"
    '  "cms": "wordpress" | "drupal" | "squarespace" | "wix" | "custom" | null,\n'
    '  "language": "en",\n'
    '  "depth_estimate": 1,\n'
    '  "has_pagination": false,\n'
    '  "has_ical": false,\n'
    '  "candidate_links": []\n'
    "}\n\n"
    "depth_estimate:\n"
    "  1 = events visible on homepage or one standard click (/events, /calendar)\n"
    "  2 = events under a sub-path (/programme/2025/, /visit/whats-on/)\n"
    "  3 = deeply nested, multi-level, or paginated\n\n"
    "candidate_links: up to 5 ABSOLUTE URLs from the page most likely to list events.\n"
    "Look for link text: What's On, Events, Calendar, Programme, Season, Agenda, "
    "Exhibitions, Upcoming, Schedule, Tickets, Shows, Performances.\n"
    "Only include URLs that start with http. Exclude social media, press, shop, donate, jobs."
)

_FALLBACK = SiteProfile(
    language="en",
    depth_estimate=2,
    has_pagination=False,
    has_ical=False,
    candidate_links=[],
)


def profile(homepage_content: str, base_url: str) -> SiteProfile:
    """Classify a venue homepage. Returns SiteProfile. Never raises."""
    if not config.OPENROUTER_API_KEY or not homepage_content.strip():
        return _FALLBACK

    llm = ChatOpenAI(
        model=_MODEL,
        api_key=config.OPENROUTER_API_KEY,
        base_url=_OPENROUTER_BASE,
        temperature=0,
    )

    try:
        response = llm.invoke([
            SystemMessage(content=_SYSTEM),
            HumanMessage(content=(
                f"Base URL: {base_url}\n\n"
                f"Homepage content:\n{homepage_content[:5000]}"
            )),
        ])
        data = json.loads(response.content.strip())
        return SiteProfile(
            cms=data.get("cms"),
            language=str(data.get("language", "en")),
            depth_estimate=max(1, min(3, int(data.get("depth_estimate", 2)))),
            has_pagination=bool(data.get("has_pagination", False)),
            has_ical=bool(data.get("has_ical", False)),
            candidate_links=[
                str(u) for u in data.get("candidate_links", [])
                if isinstance(u, str) and u.startswith("http")
            ][:5],
        )
    except Exception:
        return _FALLBACK
