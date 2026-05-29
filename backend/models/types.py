from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class CityInfo:
    name: str
    country: str          # ISO 3166-1 alpha-2, e.g. "US"
    lat: float
    lon: float
    display: str          # Human-readable, e.g. "Austin, Texas, United States"
    state: Optional[str] = None


@dataclass
class Venue:
    id: str               # osm_{node|way}_{osm_id}
    name: str
    type: str             # library | museum | gallery | arts_centre
    city: str
    country: str
    lat: float
    lon: float
    osm_id: str
    address: Optional[str] = None
    website: Optional[str] = None


@dataclass
class RawEvent:
    title: str
    date: str             # YYYY-MM-DD
    venue_id: str
    source_strategy: str  # ical | json_ld | navigate_html | llm_extract | search
    time: Optional[str] = None          # HH:MM local
    description: Optional[str] = None
    url: Optional[str] = None
    price: Optional[str] = None


@dataclass
class JudgedEvent(RawEvent):
    quality_score: float = 0.0
    verdict: str = "reject"             # accept | review | reject
    judged_at: Optional[datetime] = None


@dataclass
class SiteProfile:
    """Output of Navigator Agent — describes a venue website's structure."""
    language: str                  # "en" | "fr" | "de" | ...
    depth_estimate: int            # 1 = flat, 2 = one hop, 3 = deeply nested
    has_pagination: bool
    has_ical: bool
    candidate_links: list[str]     # up to 5 URLs most likely to have events
    cms: Optional[str] = None      # "wordpress" | "drupal" | "squarespace" | "custom" | None


@dataclass
class ScrapeResult:
    venue_id: str
    success: bool
    events: list[RawEvent] = field(default_factory=list)
    strategy_used: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None
    scrape_strategy: str = "fast"                    # "fast" | "thorough" | "fast+escalated"
    navigator_profile: Optional[SiteProfile] = None  # set when Path B ran
    extractor_urls: Optional[list[str]] = None       # URLs Path B actually visited


@dataclass
class RunStats:
    run_id: str
    city: str
    venues_total: int = 0
    venues_done: int = 0
    venues_failed: int = 0
    events_found: int = 0
    events_accepted: int = 0
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
