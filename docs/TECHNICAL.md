---
title: Technical Architecture
---

# Urban Rhythm — Technical Architecture

## Overview

Urban Rhythm is a multi-agent AI system that automatically discovers cultural venues in any
US city, scrapes their websites for upcoming events, and presents curated results in a
searchable 4-layer web dashboard.

At its core, the system is a **LangGraph `StateGraph`** pipeline — a directed acyclic graph
where each node is a specialized agent with a single responsibility. Parallel venue scraping
is handled via the `Send` API fan-out, allowing N venues to be processed concurrently with
results merged by a reducer.

---

## How Web Scraping Works (Plain Language)

When a human wants to find events at a library, they:
1. Open a browser and go to the library's website
2. Click "Events" or "Calendar"
3. Read the list of upcoming events

Urban Rhythm does exactly the same thing — but automatically, for hundreds of venues at once.
This process is called **web scraping**.

The challenge is that every website is structured differently:

| Website type | How events are stored | Effort to extract |
|---|---|---|
| Calendar feed (iCal) | Standardized file, machine-readable | Trivial — just parse the file |
| Structured data (JSON-LD) | Hidden code block in the page | Easy — find and parse the block |
| Regular HTML page | Human-readable text and layout | Hard — need an AI to read it |
| No events page | Not published online | Must fall back to web search |

The **Scraper Agent** handles this uncertainty by trying these approaches in order, learning
which one works for each website, and skipping failed approaches in future runs.

---

## Technology Stack

| Layer | Technology | Reason for choice |
|---|---|---|
| Frontend | React 18 + Vite | 4-layer dashboard, HMR for fast iteration |
| Backend | Python + FastAPI | Async support, SSE streaming |
| Agent Orchestration | LangGraph `StateGraph` + `Send` API | Stateful DAG with parallel fan-out |
| LLM Gateway | OpenRouter | Single API key for GPT-4o-mini + Claude Sonnet |
| City Geocoding | Nominatim (OpenStreetMap) | Free, global, no API key needed |
| Venue Discovery | OSM Overpass API | Free, global, covers all major US cities |
| Web Page Fetching | Jina Reader API | Converts raw HTML to clean markdown for LLMs |
| Web Search Fallback | Tavily API | Structured search for venues without websites |
| Database | SQLite (WAL mode) | Simple, local, no server infrastructure |
| Event Extraction LLM | GPT-4o-mini via OpenRouter | High-volume, cost-efficient structured extraction |
| Event Judging LLM | Claude 3.5 Sonnet via OpenRouter | Borderline cases only — cost-aware routing |

---

## System Architecture

```
User (browser)
     │  types "Austin, TX" → clicks RUN
     ▼
┌─────────────────────────────────┐
│           React Frontend        │
│  Layer 1: Venues                │
│  Layer 2: Run Control + Log     │  ← live progress via SSE stream
│  Layer 3: Events                │
│  Layer 4: Knowledge Graph       │
└──────────────┬──────────────────┘
               │ HTTP + SSE
               ▼
┌─────────────────────────────────┐
│         FastAPI Backend         │
│  POST /api/run                  │
│  GET  /api/run/{id}/stream      │
│  GET  /api/events               │
│  GET  /api/venues               │
│  GET  /api/graph/...            │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│                    LangGraph StateGraph Pipeline             │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │ City         │   │ Venue        │   │ Venue          │  │
│  │ Resolver     │──▶│ Discovery    │──▶│ Processor      │  │
│  │              │   │              │   │ (parallel)     │  │
│  └──────────────┘   └──────────────┘   └───────┬────────┘  │
│                                                 │           │
│                              ┌──────────────────┤           │
│                              │  per venue       │           │
│                              ▼                  ▼           │
│                      ┌──────────────┐   ┌──────────────┐   │
│                      │ Scraper      │   │ Scraper      │   │
│                      │ Agent        │   │ Agent        │   │
│                      │ (ReAct loop) │   │ (ReAct loop) │   │
│                      └──────┬───────┘   └──────┬───────┘   │
│                             └─────────┬─────────┘           │
│                                       ▼                     │
│                             ┌──────────────────┐            │
│                             │   Judge Agent    │            │
│                             └────────┬─────────┘            │
│                                      ▼                      │
│                             ┌──────────────────┐            │
│                             │ Knowledge Graph  │            │
│                             └──────────────────┘            │
└─────────────────────────────────────────────────────────────┘
               │
               ▼
        SQLite Database
        ┌─────────────┐
        │ venues      │
        │ events      │
        │ playbook    │  ← cross-run memory
        │ kg_tags     │
        │ kg_entities │
        └─────────────┘
```

---

## Agent Design

### Agent 1 — City Resolver

Translates a free-text city name into structured geographic data.

```
Input:  "Austin TX"
Output: { name: "Austin", state: "TX", country: "US", lat: 30.26, lon: -97.74 }
```

**How it works**: Calls the Nominatim API (OpenStreetMap's free geocoding service). No LLM
required — this is a deterministic lookup. If a name matches multiple cities (e.g., "Springfield"),
it picks the most populous result and logs the choice.

---

### Agent 2 — Venue Discovery

Finds all cultural venues near the resolved city coordinates.

```
Input:  lat=30.26, lon=-97.74, radius=30km, types=[library, museum, gallery, arts_centre]
Output: List of venues — name, address, website URL, OSM ID, type
```

**How it works**: Queries the OSM Overpass API — a global database of every mapped place on
Earth. The query asks for all nodes and ways tagged as library, museum, gallery, or arts_centre
within a radius of the city center.

This works for any city in the world where OSM data exists. All major English-speaking cities
(US, UK, Canada, Australia) are comprehensively mapped.

Venues without a website URL are flagged as `no_website` and skipped during scraping, but
still appear in the Venue Browser (Layer 1).

---

### Agent 3 — Scraper Agent (ReAct Loop)

This is the core of the system. It is a **ReAct agent** — a loop where the AI model alternates
between thinking, acting, and observing until it either finds events or exhausts all options.

```
Thought → Action (tool call) → Observation → Thought → Action → ...
```

**Tool set available to the agent:**

| Tool | What it does |
|---|---|
| `get_playbook(domain)` | Check if a working strategy is already recorded for this website |
| `fetch_page(url)` | Download a webpage and convert it to clean readable text |
| `find_ical_feed(html)` | Scan the page for links to calendar subscription files (.ics) |
| `parse_ical(url)` | Download and parse a calendar file into structured events |
| `extract_json_ld(html)` | Find and parse schema.org/Event structured data blocks in the page |
| `navigate_to_events(url)` | Try common paths (/events, /calendar, /whats-on) to find the events page |
| `extract_events_llm(html)` | Ask an LLM to read a webpage and extract event details |
| `search_web(query)` | Run a live web search: "[Venue] events [City] [Month Year]" |
| `save_strategy(domain, ...)` | Record the successful approach to the Playbook Store |

**Example ReAct loop for a venue:**

```
Thought: I'll check the playbook first.
Action:  get_playbook("austinlibrary.org")
Obs:     No record found. Using default order.

Thought: Try iCal first — most reliable if it exists.
Action:  fetch_page("austinlibrary.org")
Obs:     Homepage HTML. No obvious iCal link.

Action:  find_ical_feed(html)
Obs:     No iCal link found.

Thought: Try JSON-LD structured data.
Action:  extract_json_ld(html)
Obs:     No schema.org/Event blocks found.

Thought: Navigate to the events page.
Action:  navigate_to_events("austinlibrary.org")
Obs:     Found /events page. Fetching...

Action:  extract_json_ld(events_html)
Obs:     Found 14 Event blocks. Extracting...
         → 14 events extracted, all future-dated.

Thought: Success. Save this strategy.
Action:  save_strategy("austinlibrary.org", { strategy: "json_ld", path: "/events" })

Done.
```

**Stopping conditions:**

- Found ≥ 1 future-dated event → success, stop loop
- Tried ≥ 8 tool calls with no events found → give up, record failure

---

### Agent 4 — Playbook Store (Cross-Run Memory)

The Playbook Store is what makes the system smarter over time. It records successful scraping
strategies so that future runs for the same venue skip the trial-and-error phase.

**Lookup hierarchy (most specific to least):**

```
1. Exact domain match       "austinlibrary.org" → json_ld at /events
2. CMS pattern match        site runs Drupal Events module → try /?ical=1
3. No record found          → use default strategy order
```

CMS detection is done by examining HTML meta tags and script imports
(e.g., `<meta name="Generator" content="WordPress">`).

**Database schema:**

```sql
CREATE TABLE playbook (
    domain           TEXT PRIMARY KEY,
    cms_type         TEXT,       -- wordpress, squarespace, drupal, custom
    strategy         TEXT,       -- ical, json_ld, navigate_html, llm_extract, search
    strategy_detail  TEXT,       -- JSON: e.g. {"path": "/events", "ical_url": "/feed.ics"}
    success_count    INTEGER DEFAULT 0,
    failure_count    INTEGER DEFAULT 0,
    last_success_at  TIMESTAMP,
    last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### Agent 5 — Judge Agent

Scores each scraped event on quality and assigns a verdict.

**Scoring criteria:**

| Criterion | Weight |
|---|---|
| Has a valid future date | 35% |
| Has a meaningful title (not "Event" or "TBD") | 25% |
| Has a location or venue name | 20% |
| Has a description or URL | 20% |

**Verdict thresholds:**

| Score | Verdict | Default display |
|---|---|---|
| ≥ 0.65 | `accept` | Shown |
| 0.35 – 0.64 | `review` | Hidden (toggle to show) |
| < 0.35 | `reject` | Hidden |

---

### Agent 6 — Knowledge Graph

Builds semantic connections between venues based on the types of events they host. Runs after
all events for a city are judged.

**What it produces:**

- **Tags per venue** (e.g., "jazz", "children", "film", "history") weighted by frequency
- **Venue similarity scores** based on tag overlap (cosine similarity)
- **Entity detection** — artist names, exhibition titles, recurring series extracted from event text

Powers the Knowledge Graph tab (Layer 4) in the UI.

---

## LangGraph State Object

All agents share a single state object that travels through the graph. Each node reads from it
and writes updates back to it.

```python
class PipelineState(TypedDict):
    # ── Input ────────────────────────────────────────────────────
    city_query: str                         # raw input: "Austin TX"

    # ── After City Resolver ──────────────────────────────────────
    city: CityInfo                          # resolved name, lat, lon, country

    # ── After Venue Discovery ────────────────────────────────────
    venues: List[Venue]                     # all venues found in city
    venue_queue: List[str]                  # venue IDs not yet processed

    # ── During Scraper (per venue, parallel) ─────────────────────
    current_venue: Venue
    scrape_attempts: List[ScrapeAttempt]    # log of each tool call tried
    raw_events: List[RawEvent]

    # ── After Judge ──────────────────────────────────────────────
    judged_events: List[JudgedEvent]

    # ── Run metadata ─────────────────────────────────────────────
    run_id: str
    stats: RunStats                         # counts, timings, cost estimate

    # ── Agent messages (ReAct loop) ──────────────────────────────
    messages: Annotated[List[BaseMessage], add_messages]
```

---

## API Endpoints (FastAPI)

```
POST /api/run                  Start a pipeline run
                               Body: { "city": "Austin TX", "radius_km": 30 }
                               Returns: { "run_id": "..." }

GET  /api/run/{id}/stream      Live progress (SSE stream)
                               Emits: venue_start, venue_done, venue_error, run_done

GET  /api/venues               List venues with filters
                               Query: city, type, status, has_website

GET  /api/events               List events with filters
                               Query: city, verdict, date_from, date_to, venue_type, limit

GET  /api/graph/tags           Tag cloud for Knowledge Graph
GET  /api/graph/search         Search venues by tag or entity name
GET  /api/graph/venue/{id}     Full knowledge card for a venue

GET  /api/health               Health check
```

---

## Full Data Flow (End to End)

```
1. User types "Austin" → clicks RUN in Layer 2

2. Browser sends:  POST /api/run { city: "Austin" }
   Server returns: { run_id: "run_abc123" }

3. Browser opens SSE stream: GET /api/run/run_abc123/stream

4. LangGraph graph begins:

   a. City Resolver
      "Austin" → Nominatim → { lat: 30.26, lon: -97.74, country: US }

   b. Venue Discovery
      Overpass query → 87 venues found (42 libraries, 31 museums, 9 galleries, 5 arts centres)
      → Saved to SQLite venues table
      → SSE event: { phase: "discovery_done", count: 87 }

   c. Venue Processing (parallel, 8 at a time)
      For each venue:
        → Scraper Agent (ReAct loop)
        → SSE events: venue_start, step updates, venue_done / venue_error

   d. Judge Agent
      All raw events → scored and labeled
      → Saved to SQLite events table

   e. Knowledge Graph
      Events analyzed → tags and similarities computed
      → Saved to SQLite kg_* tables

   f. SSE event: { phase: "run_done", events: 342, venues_scraped: 71, venues_failed: 16 }

5. User sees events in Layer 3 (accept by default)
```

---

## Cost Estimate Per City Run

Based on 50 venues, average 4 LLM calls per venue:

| LLM usage | Model | Est. calls | Est. cost |
|---|---|---|---|
| Event extraction + strategy | GPT-4o-mini | ~150 | ~$0.30 |
| Event judging (borderline only) | Claude 3.5 Sonnet | ~50 | ~$0.40 |
| Web search fallback | Tavily | ~20 | ~$0.05 |
| **Total** | | | **~$0.75** |

Costs decrease on repeat runs of the same city as the Playbook fills in.

