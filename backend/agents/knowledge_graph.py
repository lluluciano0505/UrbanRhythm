"""
M08 — Knowledge Graph
Extracts per-event semantic tags and named entities from accepted events, computes
venue similarity from tag weight vectors, and persists all results to DB.

Public interface: update(city, events) -> None
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

import config
import data.database as db
from models.types import JudgedEvent

_GPT_MODEL = "openai/gpt-4o-mini"
_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_SIMILARITY_THRESHOLD = 0.4

_SYSTEM_PROMPT = (
    "You are analyzing events at a cultural venue to extract thematic information.\n"
    "For each event (by its index), assign 1-3 relevant thematic tags in English.\n"
    "Use consistent lowercase tags. Examples: jazz, contemporary_art, film, photography, "
    "history, children, dance, theatre, music, literature, science, fashion, comedy.\n"
    "Also extract named entities mentioned across all events.\n\n"
    "Return ONLY a JSON object with this exact structure:\n"
    "{\n"
    "  \"event_tags\": [\n"
    "    {\"event_idx\": 0, \"tags\": [\"jazz\", \"music\"]},\n"
    "    ...\n"
    "  ],\n"
    "  \"entities\": [\n"
    "    {\"name\": \"Miles Davis\", \"type\": \"person\"},\n"
    "    ...\n"
    "  ]\n"
    "}\n"
    "Entity types must be one of: person, exhibition, series, other.\n"
    "No explanation, no markdown — only raw JSON."
)


def update(city: str, events: list[JudgedEvent]) -> None:
    """Process accepted events for a city. Overwrites existing KG data for the city."""
    accepted = [e for e in events if e.verdict == "accept"]
    if not accepted:
        return

    by_venue: dict[str, list[JudgedEvent]] = defaultdict(list)
    for e in accepted:
        by_venue[e.venue_id].append(e)

    tag_vectors: dict[str, dict[str, float]] = {}

    for venue_id, venue_events in by_venue.items():
        per_event_tags, entities = _extract_tags_and_entities(venue_events)
        tag_weights = _compute_weights(per_event_tags, len(venue_events))
        tag_vectors[venue_id] = tag_weights

        db.upsert_kg_tags(
            venue_id,
            [{"tag": t, "weight": w} for t, w in tag_weights.items()],
            city,
        )
        db.upsert_kg_entities(venue_id, entities, city)

    db.clear_kg_similarity(city)

    venue_ids = list(tag_vectors.keys())
    for i in range(len(venue_ids)):
        for j in range(i + 1, len(venue_ids)):
            a, b = venue_ids[i], venue_ids[j]
            score = _cosine_similarity(tag_vectors[a], tag_vectors[b])
            if score >= _SIMILARITY_THRESHOLD:
                db.upsert_kg_similarity(a, b, score, city)


# ── LLM extraction ────────────────────────────────────────────────────────────


def _extract_tags_and_entities(
    events: list[JudgedEvent],
) -> tuple[list[list[str]], list[dict]]:
    """Returns (per_event_tags, entities). per_event_tags[i] = tags for events[i]."""
    llm = ChatOpenAI(
        model=_GPT_MODEL,
        api_key=config.OPENROUTER_API_KEY,
        base_url=_OPENROUTER_BASE,
        temperature=0,
    )

    event_lines = "\n".join(
        f"{i}. Title: {e.title}"
        + (f" | Description: {e.description[:200]}" if e.description else "")
        for i, e in enumerate(events)
    )

    try:
        response = llm.invoke([
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(content=f"Venue events:\n{event_lines}"),
        ])
        data = json.loads(response.content.strip())
    except Exception:
        return [[] for _ in events], []

    if not isinstance(data, dict):
        return [[] for _ in events], []

    per_event_tags: list[list[str]] = [[] for _ in events]
    for entry in (data.get("event_tags") or []):
        if not isinstance(entry, dict):
            continue
        idx = entry.get("event_idx")
        if isinstance(idx, int) and 0 <= idx < len(events):
            tags_raw = entry.get("tags") or []
            per_event_tags[idx] = [_normalize_tag(t) for t in tags_raw if isinstance(t, str)]

    entities: list[dict] = []
    valid_types = {"person", "exhibition", "series", "other"}
    for ent in (data.get("entities") or []):
        if not isinstance(ent, dict):
            continue
        name = (ent.get("name") or "").strip()
        etype = ent.get("type") or "other"
        if name and etype in valid_types:
            entities.append({"entity_name": name, "entity_type": etype})

    return per_event_tags, entities


# ── Tag helpers ───────────────────────────────────────────────────────────────


def _normalize_tag(tag: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", tag.lower().strip()).strip("_")


def _compute_weights(per_event_tags: list[list[str]], total_events: int) -> dict[str, float]:
    """Weight = count_of_events_with_tag / total_events (each tag counted once per event)."""
    if total_events == 0:
        return {}
    counts: dict[str, int] = defaultdict(int)
    for tags in per_event_tags:
        for tag in set(tags):
            counts[tag] += 1
    return {tag: round(count / total_events, 4) for tag, count in counts.items() if tag}


# ── Cosine similarity ─────────────────────────────────────────────────────────


def _cosine_similarity(a: dict[str, float], b: dict[str, float]) -> float:
    all_tags = set(a) | set(b)
    dot = sum(a.get(t, 0.0) * b.get(t, 0.0) for t in all_tags)
    mag_a = math.sqrt(sum(v ** 2 for v in a.values()))
    mag_b = math.sqrt(sum(v ** 2 for v in b.values()))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return round(dot / (mag_a * mag_b), 4)
