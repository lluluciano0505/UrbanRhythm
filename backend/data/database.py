"""
M11 — Database
Owns the SQLite schema and all typed query functions.
No other module writes raw SQL.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Generator, Optional

from models.types import JudgedEvent, Venue

# ── Module-level state ────────────────────────────────────────────────────────

import config as _config
_db_path: str = _config.DB_PATH
_memory_conn: Optional[sqlite3.Connection] = None  # kept alive for :memory: tests

# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    city        TEXT NOT NULL,
    radius_km   REAL NOT NULL,
    started_at  TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    stats       TEXT
);

CREATE TABLE IF NOT EXISTS venues (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    city            TEXT NOT NULL,
    country         TEXT NOT NULL,
    address         TEXT,
    lat             REAL NOT NULL,
    lon             REAL NOT NULL,
    website         TEXT,
    osm_id          TEXT NOT NULL,
    last_osm_sync   TIMESTAMP,
    last_scraped_at TIMESTAMP,
    scrape_status   TEXT DEFAULT 'never_scraped',
    avg_events      REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    venue_id        TEXT NOT NULL REFERENCES venues(id),
    title           TEXT NOT NULL,
    date            TEXT NOT NULL,
    time            TEXT,
    description     TEXT,
    url             TEXT,
    price           TEXT,
    source_strategy TEXT,
    quality_score   REAL,
    verdict         TEXT,
    city            TEXT NOT NULL,
    judged_at       TIMESTAMP,
    run_id          TEXT REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS playbook (
    domain          TEXT PRIMARY KEY,
    cms_type        TEXT,
    strategy        TEXT,
    strategy_detail TEXT,
    success_count   INTEGER DEFAULT 0,
    failure_count   INTEGER DEFAULT 0,
    last_success_at TIMESTAMP,
    last_updated    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kg_tags (
    venue_id TEXT NOT NULL REFERENCES venues(id),
    tag      TEXT NOT NULL,
    weight   REAL NOT NULL,
    city     TEXT NOT NULL,
    PRIMARY KEY (venue_id, tag)
);

CREATE TABLE IF NOT EXISTS kg_entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_id    TEXT NOT NULL REFERENCES venues(id),
    entity_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    city        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_similarity (
    venue_id_a TEXT NOT NULL,
    venue_id_b TEXT NOT NULL,
    score      REAL NOT NULL,
    city       TEXT NOT NULL,
    PRIMARY KEY (venue_id_a, venue_id_b)
);

CREATE INDEX IF NOT EXISTS idx_venues_city    ON venues(city);
CREATE INDEX IF NOT EXISTS idx_events_venue   ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_city    ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_verdict ON events(verdict);
CREATE INDEX IF NOT EXISTS idx_kg_tags_city   ON kg_tags(city);
CREATE INDEX IF NOT EXISTS idx_kg_tags_tag    ON kg_tags(tag);
"""

# Auto-initialize on import so the DB works whether loaded via FastAPI or langgraph dev
def _auto_init() -> None:
    import os
    os.makedirs(os.path.dirname(_db_path), exist_ok=True) if os.path.dirname(_db_path) else None
    conn = sqlite3.connect(_db_path, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
    finally:
        conn.close()

_auto_init()

# ── Connection management ─────────────────────────────────────────────────────


def init_db(path: str = "data/urbanrhythm.sqlite") -> None:
    """Create tables and indexes if they don't exist. Must be called before any query."""
    global _db_path, _memory_conn

    _db_path = path

    if path == ":memory:":
        _memory_conn = sqlite3.connect(":memory:", check_same_thread=False)
        _memory_conn.row_factory = sqlite3.Row
        _memory_conn.execute("PRAGMA foreign_keys=ON")
        _memory_conn.executescript(_SCHEMA)
    else:
        _memory_conn = None
        conn = sqlite3.connect(path, check_same_thread=False)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
        finally:
            conn.close()


@contextmanager
def _conn() -> Generator[sqlite3.Connection, None, None]:
    if _memory_conn is not None:
        # In-memory: reuse the persistent connection, never close it.
        try:
            yield _memory_conn
            _memory_conn.commit()
        except Exception:
            _memory_conn.rollback()
            raise
    else:
        conn = sqlite3.connect(_db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


# ── Helpers ───────────────────────────────────────────────────────────────────


def _event_id(venue_id: str, date: str, title: str) -> str:
    """Deterministic 16-char ID: SHA256(venue_id + date + title)[:16]."""
    return hashlib.sha256(f"{venue_id}{date}{title}".encode()).hexdigest()[:16]


def _now() -> str:
    return datetime.utcnow().isoformat()


# ── Run table ─────────────────────────────────────────────────────────────────


def insert_run(run_id: str, city: str, radius_km: float, started_at: datetime) -> None:
    with _conn() as c:
        c.execute(
            "INSERT INTO runs (run_id, city, radius_km, started_at) VALUES (?, ?, ?, ?)",
            (run_id, city, radius_km, started_at.isoformat()),
        )


def get_all_finished_runs() -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT run_id, city, started_at, finished_at, stats FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC"
        ).fetchall()
    result = []
    for row in rows:
        stats = json.loads(row[4]) if row[4] else {}
        result.append({
            "run_id": row[0],
            "city": row[1],
            "started_at": row[2],
            "finished_at": row[3],
            "events_accepted": stats.get("events_accepted", 0),
            "venues_done": stats.get("venues_done", 0),
        })
    return result


def get_latest_finished_run() -> dict | None:
    with _conn() as c:
        row = c.execute(
            "SELECT run_id, city, started_at, finished_at, stats FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
        ).fetchone()
    if row is None:
        return None
    return {"run_id": row[0], "city": row[1], "started_at": row[2], "finished_at": row[3], "stats": row[4]}


def get_run(run_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute(
            "SELECT run_id, city, started_at, finished_at, stats FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    if row is None:
        return None
    return {"run_id": row[0], "city": row[1], "started_at": row[2], "finished_at": row[3], "stats": row[4]}


def finish_run(run_id: str, finished_at: datetime, stats: dict) -> None:
    with _conn() as c:
        c.execute(
            "UPDATE runs SET finished_at = ?, stats = ? WHERE run_id = ?",
            (finished_at.isoformat(), json.dumps(stats), run_id),
        )


# ── Venue table ───────────────────────────────────────────────────────────────


def upsert_venue(venue: Venue) -> None:
    with _conn() as c:
        c.execute(
            """
            INSERT INTO venues
                (id, name, type, city, country, address, lat, lon, website, osm_id, last_osm_sync)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name          = excluded.name,
                type          = excluded.type,
                city          = excluded.city,
                country       = excluded.country,
                address       = excluded.address,
                lat           = excluded.lat,
                lon           = excluded.lon,
                website       = excluded.website,
                last_osm_sync = excluded.last_osm_sync
            """,
            (
                venue.id, venue.name, venue.type, venue.city, venue.country,
                venue.address, venue.lat, venue.lon, venue.website,
                venue.osm_id, _now(),
            ),
        )


def update_venue_scrape_status(venue_id: str, status: str, avg_events: float = 0.0) -> None:
    with _conn() as c:
        c.execute(
            "UPDATE venues SET scrape_status = ?, last_scraped_at = ?, avg_events = ? WHERE id = ?",
            (status, _now(), avg_events, venue_id),
        )


def get_venues(
    city: Optional[str] = None,
    types: Optional[list[str]] = None,
    has_website: Optional[bool] = None,
    status: Optional[str] = None,
    limit: int = 200,
) -> list[dict]:
    sql = "SELECT * FROM venues WHERE 1=1"
    params: list = []

    if city:
        sql += " AND city = ?"
        params.append(city)
    if types:
        sql += f" AND type IN ({','.join('?' * len(types))})"
        params.extend(types)
    if has_website is True:
        sql += " AND website IS NOT NULL"
    elif has_website is False:
        sql += " AND website IS NULL"
    if status:
        sql += " AND scrape_status = ?"
        params.append(status)

    sql += " LIMIT ?"
    params.append(limit)

    with _conn() as c:
        return [dict(row) for row in c.execute(sql, params).fetchall()]


# ── Event table ───────────────────────────────────────────────────────────────


def upsert_event(event: JudgedEvent, city: str, run_id: Optional[str] = None) -> None:
    """Upsert key is SHA256(venue_id + date + title)[:16], implementing FR-14b."""
    eid = _event_id(event.venue_id, event.date, event.title)
    with _conn() as c:
        c.execute(
            """
            INSERT INTO events
                (id, venue_id, title, date, time, description, url, price,
                 source_strategy, quality_score, verdict, city, judged_at, run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                time            = excluded.time,
                description     = excluded.description,
                url             = excluded.url,
                price           = excluded.price,
                source_strategy = excluded.source_strategy,
                quality_score   = excluded.quality_score,
                verdict         = excluded.verdict,
                judged_at       = excluded.judged_at,
                run_id          = excluded.run_id
            """,
            (
                eid, event.venue_id, event.title, event.date, event.time,
                event.description, event.url, event.price,
                event.source_strategy, event.quality_score, event.verdict,
                city,
                event.judged_at.isoformat() if event.judged_at else None,
                run_id,
            ),
        )


def get_events(
    city: Optional[str] = None,
    verdicts: Optional[list[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    venue_type: Optional[str] = None,
    limit: int = 200,
) -> list[dict]:
    sql = """
        SELECT e.*, v.type AS venue_type, v.name AS venue_name, v.lat AS venue_lat, v.lon AS venue_lon, v.website AS venue_website
        FROM events e
        LEFT JOIN venues v ON e.venue_id = v.id
        WHERE 1=1
    """
    params: list = []

    if city:
        sql += " AND e.city = ?"
        params.append(city)
    if verdicts:
        sql += f" AND e.verdict IN ({','.join('?' * len(verdicts))})"
        params.extend(verdicts)
    if date_from:
        sql += " AND e.date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND e.date <= ?"
        params.append(date_to)
    if venue_type:
        sql += " AND v.type = ?"
        params.append(venue_type)

    sql += " ORDER BY e.date ASC LIMIT ?"
    params.append(limit)

    with _conn() as c:
        return [dict(row) for row in c.execute(sql, params).fetchall()]


# ── Playbook table ────────────────────────────────────────────────────────────


def get_playbook(domain: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM playbook WHERE domain = ?", (domain,)).fetchone()
    if not row:
        return None
    result = dict(row)
    raw = result.get("strategy_detail")
    result["strategy_detail"] = json.loads(raw) if raw else {}
    return result


def upsert_playbook(
    domain: str,
    strategy: Optional[str],
    strategy_detail: dict,
    success: bool,
    cms_type: Optional[str] = None,
) -> None:
    now = _now()
    # Atomically increment the appropriate counter using ON CONFLICT DO UPDATE.
    # In the UPDATE clause, bare column names refer to the existing row;
    # excluded.* refers to the values proposed by this INSERT.
    with _conn() as c:
        c.execute(
            """
            INSERT INTO playbook
                (domain, strategy, strategy_detail, cms_type,
                 success_count, failure_count, last_success_at, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(domain) DO UPDATE SET
                strategy        = COALESCE(excluded.strategy, strategy),
                strategy_detail = excluded.strategy_detail,
                cms_type        = COALESCE(excluded.cms_type, cms_type),
                success_count   = success_count + excluded.success_count,
                failure_count   = failure_count + excluded.failure_count,
                last_success_at = CASE
                    WHEN excluded.success_count > 0 THEN excluded.last_success_at
                    ELSE last_success_at
                END,
                last_updated    = excluded.last_updated
            """,
            (
                domain,
                strategy,
                json.dumps(strategy_detail),
                cms_type,
                1 if success else 0,        # success_count delta
                0 if success else 1,        # failure_count delta
                now if success else None,   # last_success_at
                now,
            ),
        )


# ── Knowledge-graph tables ────────────────────────────────────────────────────


def upsert_kg_tags(venue_id: str, tags: list[dict], city: str) -> None:
    """tags: list of {"tag": str, "weight": float}. Replaces all tags for this venue+city."""
    with _conn() as c:
        c.execute("DELETE FROM kg_tags WHERE venue_id = ? AND city = ?", (venue_id, city))
        c.executemany(
            "INSERT INTO kg_tags (venue_id, tag, weight, city) VALUES (?, ?, ?, ?)",
            [(venue_id, t["tag"], t["weight"], city) for t in tags],
        )


def upsert_kg_entities(venue_id: str, entities: list[dict], city: str) -> None:
    """entities: list of {"entity_name": str, "entity_type": str}. Replaces all for venue+city."""
    with _conn() as c:
        c.execute("DELETE FROM kg_entities WHERE venue_id = ? AND city = ?", (venue_id, city))
        c.executemany(
            "INSERT INTO kg_entities (venue_id, entity_name, entity_type, city) VALUES (?, ?, ?, ?)",
            [(venue_id, e["entity_name"], e["entity_type"], city) for e in entities],
        )


def upsert_kg_similarity(venue_id_a: str, venue_id_b: str, score: float, city: str) -> None:
    """Stores a symmetric similarity pair. Enforces a < b lexicographically."""
    a, b = sorted([venue_id_a, venue_id_b])
    with _conn() as c:
        c.execute(
            """
            INSERT INTO kg_similarity (venue_id_a, venue_id_b, score, city)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(venue_id_a, venue_id_b) DO UPDATE SET
                score = excluded.score,
                city  = excluded.city
            """,
            (a, b, score, city),
        )


def get_venue(venue_id: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM venues WHERE id = ?", (venue_id,)).fetchone()
    return dict(row) if row else None


def get_venues_by_tag(city: Optional[str], tag: str, limit: int = 40) -> list[dict]:
    sql = """
        SELECT v.* FROM venues v
        JOIN kg_tags k ON v.id = k.venue_id
        WHERE k.tag = ?
    """
    params: list = [tag]
    if city:
        sql += " AND k.city = ?"
        params.append(city)
    sql += " ORDER BY k.weight DESC LIMIT ?"
    params.append(limit)
    with _conn() as c:
        return [dict(row) for row in c.execute(sql, params).fetchall()]


def get_venues_by_entity(city: Optional[str], entity: str, limit: int = 40) -> list[dict]:
    sql = """
        SELECT DISTINCT v.* FROM venues v
        JOIN kg_entities e ON v.id = e.venue_id
        WHERE e.entity_name = ?
    """
    params: list = [entity]
    if city:
        sql += " AND e.city = ?"
        params.append(city)
    sql += " LIMIT ?"
    params.append(limit)
    with _conn() as c:
        return [dict(row) for row in c.execute(sql, params).fetchall()]


def count_kg_similarity(city: str) -> int:
    with _conn() as c:
        row = c.execute(
            "SELECT COUNT(*) FROM kg_similarity WHERE city = ?", (city,)
        ).fetchone()
    return row[0] if row else 0


def get_kg_tags(city: Optional[str] = None) -> list[dict]:
    """Returns aggregated tag stats across all venues, optionally filtered by city."""
    sql = """
        SELECT tag,
               COUNT(DISTINCT venue_id) AS venue_count,
               AVG(weight)              AS avg_weight
        FROM kg_tags
    """
    params: list = []
    if city:
        sql += " WHERE city = ?"
        params.append(city)
    sql += " GROUP BY tag ORDER BY venue_count DESC, avg_weight DESC"
    with _conn() as c:
        return [dict(row) for row in c.execute(sql, params).fetchall()]


def get_kg_tags_for_venue(venue_id: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT tag, weight FROM kg_tags WHERE venue_id = ? ORDER BY weight DESC",
            (venue_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_kg_entities_for_venue(venue_id: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT entity_name, entity_type FROM kg_entities WHERE venue_id = ?",
            (venue_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def clear_kg_similarity(city: str) -> None:
    """Delete all kg_similarity rows for a city. Called by M08 before writing fresh pairs."""
    with _conn() as c:
        c.execute("DELETE FROM kg_similarity WHERE city = ?", (city,))


def get_kg_similarity_for_venue(venue_id: str) -> list[dict]:
    """Returns all similarity pairs involving this venue."""
    with _conn() as c:
        rows = c.execute(
            """
            SELECT CASE WHEN venue_id_a = ? THEN venue_id_b ELSE venue_id_a END AS other_venue_id,
                   score
            FROM kg_similarity
            WHERE venue_id_a = ? OR venue_id_b = ?
            ORDER BY score DESC
            """,
            (venue_id, venue_id, venue_id),
        ).fetchall()
    return [dict(row) for row in rows]
