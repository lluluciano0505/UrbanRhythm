---
title: Agents & Tools Reference
---

# UrbanRhythm — Agents & Tools Reference

## Pipeline Overview

```
city_resolver_node
      ↓
venue_discovery_node
      ↓ (Send × N, parallel)
scrape_venue_node  ──→  scrape_router  ──→  Path A or Path B
      ↓
judge_node
      ↓
knowledge_graph_node
```

---

## Pipeline Nodes

| Node | File | Type | What it does |
|---|---|---|---|
| `city_resolver_node` | `agents/city_resolver.py` | Pure API | Nominatim geocoding → `CityInfo` (lat/lon/name) |
| `venue_discovery_node` | `agents/venue_discovery.py` | Pure API | Overpass API → list of `Venue` objects within radius |
| `scrape_venue_node` | `agents/orchestrator.py` | Router | Calls `scrape_router.route(venue)` per venue |
| `judge_node` | `agents/judge_agent.py` | Rule + LLM | Scores each `RawEvent` → `JudgedEvent` with verdict |
| `knowledge_graph_node` | `agents/knowledge_graph.py` | LLM | Extracts tags + computes venue similarity |

---

## Scrape Router (`scrape_router.py`)

Entry point for every venue. Routing table:

```
venue.website is None  →  Tavily web search fallback
Path A finds ≥ 3 events  →  return fast result
Path A finds 0 events   →  escalate to Path B  (scrape_strategy = "fast+escalated")
Path A finds 1–2 events →  run Path B, keep whichever has more events
```

---

## Agents

### Path A — Fast Scraper (`scraper_agent.py`)
- **Type**: ReAct loop (LangGraph `create_react_agent`)
- **Model**: `openai/gpt-4o-mini` via OpenRouter
- **Timeout**: 30 seconds (ThreadPoolExecutor)
- **Max tool calls**: 12 (`_RECURSION_LIMIT = 25`)
- **Tools available**: all 8 tools (see below)
- **Strategy order**: ical → json_ld → find_event_links → follow link → llm_extract → search_web
- **Memory**: reads/writes `playbook_store` — remembers what worked per domain

### Path B — Thorough Scraper (`thorough_scraper.py`)
Three agents run sequentially:

| Step | Agent | Type | Input → Output |
|---|---|---|---|
| 1 | Navigator | Single LLM call | homepage markdown → `SiteProfile` |
| 2 | Strategy | Single LLM call | `SiteProfile` + base_url → `list[str]` of target URLs |
| 3 | Extractor | Parallel mini-ReAct × N URLs | target URL → `list[RawEvent]` |

- **Timeout**: 90 seconds total (ThreadPoolExecutor)

#### Navigator Agent (`navigator_agent.py`)
- **Model**: `openai/gpt-4o-mini`
- Reads homepage, outputs `SiteProfile`:
  ```
  cms, language, depth_estimate (1–3), has_pagination, has_ical, candidate_links (up to 5 URLs)
  ```
- Fallback when no candidate_links found: Strategy Agent guesses `/events`, `/calendar`, `/whats-on`, `/programmes`, `/program`

#### Strategy Agent (`strategy_agent.py`)
- **Model**: `openai/gpt-4o-mini`
- Ranks `candidate_links` → ordered list of up to 5 target URLs
- Fallback (no candidate_links): generates common paths from base domain

#### Extractor Agent (`extractor_agent.py`)
- **Type**: mini-ReAct loop per URL, parallel via `ThreadPoolExecutor(max_workers=3)`
- **Model**: `openai/gpt-4o-mini`
- **Max tool calls per URL**: 4
- **Tools**: `fetch_page`, `find_ical_feed`, `parse_ical`, `extract_events_llm`
- Deduplicates results by `(title.lower(), date)`

### Judge Agent (`judge_agent.py`)
- **Type**: Rule-based scoring + LLM refinement for borderline cases
- **Rule score** (0.0–1.0): date in future (+0.35), non-generic title (+0.25), has venue (+0.20), has description or URL (+0.20)
- **LLM refinement**: only called when rule score is in [0.40, 0.70]
- **LLM model**: `anthropic/claude-3-5-sonnet` via OpenRouter
- **Verdict thresholds**: accept ≥ 0.65 · review ≥ 0.35 · reject < 0.35

### Knowledge Graph (`knowledge_graph.py`)
- **Model**: `openai/gpt-4o-mini`
- Input: all accepted events for a city
- Extracts per-event thematic tags (e.g. `jazz`, `contemporary_art`, `film`)
- Computes cosine similarity between venues based on tag weight vectors
- Stores tags, entities, and similarity pairs in SQLite

---

## Tools (`scraper_tools.py`)

All 8 tools are `@tool`-decorated functions available to Path A's ReAct agent.
Path B's Extractor uses a subset of 4.

| Tool | Used by | What it does |
|---|---|---|
| `fetch_page(url)` | Path A + Extractor | Fetches URL via Jina Reader API → clean markdown. 30s timeout. Returns `""` on Cloudflare block. |
| `find_ical_feed(html)` | Path A + Extractor | Regex-scans page for `.ics` / `webcal://` / `ical` URLs → JSON array of feed URLs |
| `parse_ical(url)` | Path A + Extractor | Downloads + parses iCal feed → JSON array of future events |
| `extract_json_ld(html)` | Path A | Extracts `Event` / `EventSeries` JSON-LD blocks from HTML → events |
| `find_event_links(html, base_url)` | Path A | LLM reads all homepage links, picks top 3 most likely to lead to events. Returns `[{url, reason}]` |
| `navigate_to_events(base_url)` | Path A | Tries hardcoded paths (`/events`, `/calendar`, `/whats-on`, …) via direct HTTP. Returns first working URL. |
| `extract_events_llm(html, venue_name, city)` | Path A + Extractor | GPT-4o-mini reads page text, extracts events as JSON array |
| `search_web(query)` | Path A | Tavily search → JSON array of events (used as last resort) |

---

## External APIs

| Service | Used for | Key required |
|---|---|---|
| OpenRouter | All LLM calls (GPT-4o-mini, Claude Sonnet) | `OPENROUTER_API_KEY` |
| Jina Reader (`r.jina.ai`) | `fetch_page` — converts URLs to clean markdown | `JINA_API_KEY` (optional, works without) |
| Tavily | `search_web` + no-website venue fallback | `TAVILY_API_KEY` |
| Nominatim (OpenStreetMap) | `city_resolver` — geocoding | none |
| Overpass API | `venue_discovery` — find venues by type | none |

---

## Data Models (`models/types.py`)

| Model | Key fields |
|---|---|
| `CityInfo` | `name`, `country`, `lat`, `lon`, `display`, `state` |
| `Venue` | `id`, `name`, `city`, `website`, `type`, `lat`, `lon`, `osm_id` |
| `SiteProfile` | `cms`, `language`, `depth_estimate`, `has_pagination`, `has_ical`, `candidate_links` |
| `RawEvent` | `title`, `date`, `time`, `description`, `url`, `price`, `venue_id`, `source_strategy` |
| `ScrapeResult` | `venue_id`, `success`, `events[]`, `scrape_strategy`, `error`, `navigator_profile`, `extractor_urls` |
| `JudgedEvent` | all `RawEvent` fields + `quality_score`, `verdict`, `judged_at` |
| `RunStats` | `run_id`, `city`, `venues_total/done/failed`, `events_found/accepted`, `started/finished_at` |

---

## `scrape_strategy` Values

| Value | Meaning |
|---|---|
| `"fast"` | Path A only (found ≥ 3 events, or Path B didn't improve) |
| `"fast+escalated"` | Path B ran (Path A found 0–2 events), Path B result used |
| `"thorough"` | Path B ran but returned error/timeout |
| `"tavily"` | Venue had no website — used Tavily web search directly |
