"""
M02 — Venue Discovery
Finds cultural venues within a radius of city coordinates using the OSM Overpass API.
Caches results per city in the venues table for 7 days.

Dependencies: Overpass API (HTTP POST, no key required), M11 (venues table).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import httpx

import data.database as db
from models.types import CityInfo, Venue

_OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]
_HEADERS = {"User-Agent": "UrbanRhythm/1.0 (contact: github.com/urbanrhythm)"}
_TIMEOUT = 60.0
_CACHE_TTL_DAYS = 7

# Maps each venue type to the (OSM-key, OSM-value) pair used in the Overpass query.
# tourism=gallery takes precedence over amenity=arts_centre during classification;
# both are queried when "gallery" is requested so that elements tagged with both
# are captured.
_TYPE_QUERY_TAGS: dict[str, tuple[str, str]] = {
    "library":      ("amenity",  "library"),
    "museum":       ("tourism",  "museum"),
    "gallery":      ("tourism",  "gallery"),
    "arts_centre":  ("amenity",  "arts_centre"),
    "theatre":      ("amenity",  "theatre"),
    "cinema":       ("amenity",  "cinema"),
}


def discover(city: CityInfo, radius_km: float, types: list[str]) -> list[Venue]:
    """
    Return all cultural venues of the requested types within radius_km of city.

    Uses a cached result if one exists in the DB for this city that is less
    than 7 days old; otherwise fetches fresh data from the Overpass API and
    upserts every venue into the DB before returning.
    """
    cached = _get_cached_rows(city.name)
    if cached is not None:
        return [_row_to_venue(row) for row in cached if row["type"] in types]

    venues = _fetch_from_overpass(city, radius_km, types)
    for v in venues:
        db.upsert_venue(v)
    return venues


# ── Cache ─────────────────────────────────────────────────────────────────────


def _get_cached_rows(city_name: str) -> Optional[list[dict]]:
    """
    Returns all cached venue rows for this city if they are fresh (< 7 days old),
    or None if the cache is empty or stale.
    """
    rows = db.get_venues(city=city_name)
    if not rows:
        return None

    cutoff = datetime.utcnow() - timedelta(days=_CACHE_TTL_DAYS)
    synced = [r["last_osm_sync"] for r in rows if r.get("last_osm_sync")]
    if not synced:
        return None

    try:
        newest = max(datetime.fromisoformat(ts) for ts in synced)
    except (ValueError, TypeError):
        return None

    return rows if newest > cutoff else None


# ── Overpass query ────────────────────────────────────────────────────────────


def _build_overpass_query(lat: float, lon: float, radius_m: float, types: list[str]) -> str:
    """Build an Overpass QL query for the requested venue types in a radius."""
    lines = ["[out:json][timeout:60];", "("]
    for t in types:
        if t not in _TYPE_QUERY_TAGS:
            continue
        key, val = _TYPE_QUERY_TAGS[t]
        around = f"(around:{radius_m:.0f},{lat},{lon})"
        lines.append(f'  node["{key}"="{val}"]{around};')
        lines.append(f'  way["{key}"="{val}"]{around};')
    lines.append(");")
    lines.append("out center tags;")
    return "\n".join(lines)


def _fetch_from_overpass(city: CityInfo, radius_km: float, types: list[str]) -> list[Venue]:
    radius_m = radius_km * 1000
    query = _build_overpass_query(city.lat, city.lon, radius_m, types)

    last_exc: Exception = RuntimeError("No Overpass instance tried")
    for url in _OVERPASS_URLS:
        try:
            # POST with form-encoded body is the standard Overpass method.
            resp = httpx.post(
                url,
                data={"data": query},
                headers=_HEADERS,
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except httpx.HTTPError as exc:
            last_exc = exc
            continue
    else:
        raise RuntimeError(f"Overpass API unavailable: {last_exc}") from last_exc

    return _parse_elements(data.get("elements", []), city, types)


# ── Response parsing ──────────────────────────────────────────────────────────


def _classify_type(tags: dict) -> Optional[str]:
    """
    Determine venue type from OSM tags.
    tourism=gallery takes precedence (answer to the gallery-subtype question):
    any element with tourism=gallery is a gallery regardless of amenity value.
    """
    if tags.get("tourism") == "gallery":
        return "gallery"
    if tags.get("amenity") == "library":
        return "library"
    if tags.get("tourism") == "museum":
        return "museum"
    if tags.get("amenity") == "arts_centre":
        return "arts_centre"
    return None


def _build_address(tags: dict) -> Optional[str]:
    num = tags.get("addr:housenumber", "")
    street = tags.get("addr:street", "")
    city = tags.get("addr:city", "")

    parts: list[str] = []
    if num and street:
        parts.append(f"{num} {street}")
    elif street:
        parts.append(street)
    if city:
        parts.append(city)
    return ", ".join(parts) if parts else None


def _parse_elements(elements: list[dict], city: CityInfo, types: list[str]) -> list[Venue]:
    venues: list[Venue] = []
    for el in elements:
        tags = el.get("tags", {})

        venue_type = _classify_type(tags)
        if not venue_type or venue_type not in types:
            continue

        el_type: str = el["type"]   # "node" or "way"
        el_id: str = str(el["id"])
        venue_id = f"osm_{el_type}_{el_id}"

        if el_type == "node":
            lat = el.get("lat")
            lon = el.get("lon")
        else:
            center = el.get("center", {})
            lat = center.get("lat")
            lon = center.get("lon")

        if lat is None or lon is None:
            continue

        name = tags.get("name", "").strip()
        if not name:
            continue

        website = tags.get("website") or tags.get("contact:website") or None
        address = _build_address(tags)

        venues.append(
            Venue(
                id=venue_id,
                name=name,
                type=venue_type,
                city=city.name,
                country=city.country,
                lat=float(lat),
                lon=float(lon),
                osm_id=el_id,
                address=address,
                website=website,
            )
        )
    return venues


# ── DB row → Venue ────────────────────────────────────────────────────────────


def _row_to_venue(row: dict) -> Venue:
    return Venue(
        id=row["id"],
        name=row["name"],
        type=row["type"],
        city=row["city"],
        country=row["country"],
        lat=row["lat"],
        lon=row["lon"],
        osm_id=row["osm_id"],
        address=row.get("address"),
        website=row.get("website"),
    )
