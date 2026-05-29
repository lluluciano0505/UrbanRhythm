"""
M01 — City Resolver
Translates a free-text city name into structured geographic data via Nominatim.

Dependencies: Nominatim REST API (HTTP GET, no key required). No database, no LLM.
"""

from __future__ import annotations

import httpx

from models.types import CityInfo

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_HEADERS = {"User-Agent": "UrbanRhythm/1.0 (contact: github.com/urbanrhythm)"}
_TIMEOUT = 10.0


class CityNotFoundError(Exception):
    """Raised when Nominatim returns no usable results or is unreachable."""


def resolve(query: str) -> CityInfo:
    """
    Translate a free-text city string into a CityInfo.

    Raises CityNotFoundError if no result is found or the API is unavailable.
    """
    try:
        resp = httpx.get(
            _NOMINATIM_URL,
            params={
                "q": query,
                "format": "jsonv2",
                "limit": 5,
                "featuretype": "city,town",
                "addressdetails": 1,
            },
            headers=_HEADERS,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        results = resp.json()
    except httpx.HTTPError:
        raise CityNotFoundError("Nominatim unavailable")

    # Filter to nodes and relations. jsonv2 format uses "category" not "class",
    # and featuretype=city,town already limits scope — no extra category check needed.
    candidates = [
        r for r in results
        if r.get("osm_type") in ("node", "relation")
    ]

    if not candidates:
        raise CityNotFoundError(query)

    best = max(candidates, key=lambda r: float(r.get("importance", 0)))

    return _build_city_info(best)


def _build_city_info(result: dict) -> CityInfo:
    address = result.get("address", {})

    # City name: prefer structured address fields over the raw display_name.
    name = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or result.get("display_name", "").split(",")[0].strip()
    )

    # State: full name as returned by Nominatim (e.g. "Texas", not "TX").
    # The spec CityInfo.state docstring says "e.g. TX" but the display-string
    # example shows "Austin, Texas, United States", so we use the full name.
    state: str | None = address.get("state") or None

    # Country: ISO alpha-2 code (Nominatim returns lowercase, e.g. "us").
    country = address.get("country_code", "").upper()

    # Full country name for the display string.
    country_name = address.get("country", country)

    lat = float(result["lat"])
    lon = float(result["lon"])

    # Build display string, omitting state when absent (e.g. for UK cities).
    if state:
        display = f"{name}, {state}, {country_name}"
    else:
        display = f"{name}, {country_name}"

    return CityInfo(
        name=name,
        state=state,
        country=country,
        lat=lat,
        lon=lon,
        display=display,
    )
