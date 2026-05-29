"""
M03 — Playbook Store
Persists and retrieves scraping strategies that have worked for specific website domains.
This is the system's cross-run memory.

Dependencies: M11 (playbook table only). No LLM, no HTTP.

Lookup hierarchy (evaluated by callers, not by get() alone):
  1. get(domain)           — exact domain match with success_count > 0
  2. detect_cms(html)      — caller fetches homepage, passes HTML here
     get_cms_defaults(cms) — returns known-good strategy for that CMS
  3. None                  — caller uses default strategy order

Note: get() only implements step 1 because step 2 requires HTML that must be
fetched by M05 (Scraper Agent) via M04 tools. M03 has no HTTP dependency.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from data import database as db


@dataclass
class Strategy:
    strategy: str          # ical | json_ld | navigate_html | llm_extract | search
    detail: dict           # strategy-specific params, e.g. {"ical_path": "/calendar.ics"}
    cms_type: Optional[str]
    confidence: float      # success_count / (success_count + failure_count)


# ── CMS default strategies ────────────────────────────────────────────────────

_CMS_DEFAULTS: dict[str, Strategy] = {
    "wordpress": Strategy(
        strategy="ical",
        detail={"paths": ["/?ical=1", "/events/feed/"]},
        cms_type="wordpress",
        confidence=0.5,
    ),
    "squarespace": Strategy(
        strategy="json_ld",
        detail={},
        cms_type="squarespace",
        confidence=0.5,
    ),
    "drupal": Strategy(
        strategy="navigate_html",
        detail={"path": "/events"},
        cms_type="drupal",
        confidence=0.5,
    ),
    "webflow": Strategy(
        strategy="json_ld",
        detail={},
        cms_type="webflow",
        confidence=0.5,
    ),
}

# ── CMS detection patterns ────────────────────────────────────────────────────

# WordPress: match meta generator tag regardless of attribute order
_WP_PATTERN_1 = re.compile(
    r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']WordPress',
    re.IGNORECASE,
)
_WP_PATTERN_2 = re.compile(
    r'<meta[^>]+content=["\']WordPress[^"\']*["\'][^>]+name=["\']generator["\']',
    re.IGNORECASE,
)


# ── Public interface ──────────────────────────────────────────────────────────


def get(domain: str) -> Optional[Strategy]:
    """
    Step 1 of the lookup hierarchy: return a recorded strategy for this domain
    if one exists with at least one prior success.
    Returns None if no record or no successful attempt yet.
    """
    row = db.get_playbook(domain)
    if not row or not row.get("strategy") or row["success_count"] == 0:
        return None

    total = row["success_count"] + row["failure_count"]
    confidence = row["success_count"] / total if total > 0 else 0.0

    return Strategy(
        strategy=row["strategy"],
        detail=row["strategy_detail"] or {},
        cms_type=row.get("cms_type"),
        confidence=confidence,
    )


def save(
    domain: str,
    strategy: Optional[str],
    detail: dict,
    success: bool,
    cms_type: Optional[str] = None,
) -> None:
    """
    Record the outcome of a scraping attempt for this domain.
    Increments success_count or failure_count accordingly.
    On failure, strategy should be None and detail should be {}.
    """
    db.upsert_playbook(domain, strategy, detail, success, cms_type)


def detect_cms(html: str) -> Optional[str]:
    """
    Step 2 helper: inspect homepage HTML for known CMS signatures.
    Returns the CMS name ("wordpress", "squarespace", "drupal", "webflow") or None.
    Caller is responsible for fetching the HTML (M04 fetch_page).
    """
    if _WP_PATTERN_1.search(html) or _WP_PATTERN_2.search(html):
        return "wordpress"
    if "Squarespace.SQUARESPACE_V6" in html:
        return "squarespace"
    if "Drupal.settings" in html:
        return "drupal"
    if "data-wf-site" in html:
        return "webflow"
    return None


def get_cms_defaults(cms_type: str) -> Optional[Strategy]:
    """
    Step 2 continuation: return the default strategy for a detected CMS.
    Returns None if the CMS is unknown.
    """
    return _CMS_DEFAULTS.get(cms_type)
