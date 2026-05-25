---
title: Design Decisions
---

# UrbanRhythm — Design Decisions

*How I thought through the architecture of an agentic event-discovery pipeline.*

---

## The Core Problem

Scraping cultural events from venue websites sounds simple until you try it at scale. The difficulty isn't writing a scraper — it's that every website is structurally different:

- Austin Public Library publishes an iCal feed
- The Blanton Museum embeds JSON-LD in its HTML
- A small gallery has a hand-built WordPress page where events are just paragraphs of text
- Some venues don't publish events online at all

A traditional scraper that handles one website can't generalize. The question I started with was: **can an agent figure out the right approach for each venue on its own?**

---

## Decision 1: Why a DAG, not a single agent

The natural first instinct is one LLM agent that does everything: find venues, scrape them, judge results. The problem is that different stages have fundamentally different failure modes and resource costs:

- **Venue discovery** is deterministic — Overpass API returns the same venues every time, no LLM needed
- **Scraping** is per-venue and highly parallel — you don't want one slow venue blocking the rest
- **Judging** needs to happen after all venues are done — it's a batch operation over all raw events
- **Knowledge graph** depends on accepted events only — it runs last

A monolithic agent would serialize all of this and mix concerns. Instead I used **LangGraph's `StateGraph`** to model the pipeline as a DAG where each node has a single responsibility and the graph handles execution order and parallelism.

The key move: LangGraph's **`Send` API** lets you fan out to N parallel `scrape_venue_node` invocations — one per venue — and merge results back via an `operator.add` reducer. This means 80 venues in Austin get scraped concurrently instead of sequentially.

```
city_resolver → venue_discovery → [Send × N] scrape_venue → judge → knowledge_graph
                                         ↑
                              each venue gets its own parallel execution
```

---

## Decision 2: Dual-path scraping (Fast vs. Thorough)

Within each venue's scrape, I designed two paths:

**Path A — Fast (ReAct loop, 30s timeout)**
A `create_react_agent` with 8 tools: fetch page, find iCal, parse iCal, extract JSON-LD, navigate to event links, LLM-extract from HTML, web search. The agent reasons through these in order and stops as soon as it finds events. GPT-4o-mini runs the loop.

**Path B — Thorough (Navigator → Strategy → Extractor, 90s timeout)**
Three sequential single-purpose LLM calls:
1. Navigator classifies the site structure (CMS type, depth, candidate links)
2. Strategy ranks which URLs to target
3. Extractor spawns mini-ReAct agents per URL, in parallel

**Routing logic:**

```
Path A finds ≥ 3 events  →  done, return fast result
Path A finds 0 events    →  escalate to Path B immediately
Path A finds 1–2 events  →  run Path B, keep whichever result has more
```

The key insight: Path A is cheap and fast and works for ~70% of venues. Path B is more expensive but navigates complex site structures. The router avoids running Path B when it isn't needed.

---

## Decision 3: Model routing — cheap model for volume, expensive model for judgment

There are two distinct cognitive tasks in this pipeline:

| Task | What it requires | Model |
|---|---|---|
| Extract structured events from HTML | Pattern matching, JSON output | GPT-4o-mini |
| Classify site structure, rank URLs | Shallow reasoning | GPT-4o-mini |
| Judge whether an event is real and specific | Nuanced language understanding | Claude 3.5 Sonnet |
| Extract semantic tags and entities | Consistent taxonomy, JSON output | GPT-4o-mini |

The scraping and classification tasks are high-volume (one LLM call per URL per venue) and don't require deep reasoning — they need to recognize patterns reliably and output valid JSON. GPT-4o-mini is fast and cheap here.

The judge is the one place where the quality of reasoning matters. A borderline event — something with a plausible title but thin description — requires the model to make a judgment call about whether it looks like a real event. Claude Sonnet handles this better.

**The hybrid judge** specifically: I first run a rule-based scorer (future date, non-generic title, has description, has URL). Only events scoring in [0.40, 0.70] get sent to Claude. Events scoring above 0.70 or below 0.40 are decided by rules alone. This means Claude handles ~20% of events rather than 100%, cutting cost by ~4x without meaningfully hurting quality.

---

## Decision 4: Playbook — cross-run memory at the domain level

Every time an agent succeeds in extracting events, it records what worked:

```
domain: "austinlibrary.org"
strategy: "json_ld"
strategy_detail: { "path": "/events" }
success_count: 3
```

On the next run for any venue on the same domain, the agent reads this record and skips straight to the known-working strategy. No trial-and-error for venues the system has seen before.

This is intentionally narrow. The Playbook doesn't try to learn generalized scraping patterns across sites — it just remembers per-domain what worked. This keeps the memory system simple and reliable. A more ambitious design might learn "all Drupal sites with the Events module respond to `/?ical=1`" — but that's a future optimization, not a V1 requirement.

---

## Decision 5: Jina Reader as the page-fetching layer

Raw HTML is terrible input for an LLM — it's full of nav menus, footers, ads, and script tags that consume tokens without carrying meaning. I route all page fetches through **Jina Reader** (`r.jina.ai`), which strips HTML and returns clean markdown. This:

- Reduces token count by ~60–70% compared to raw HTML
- Makes event content easier for the model to locate
- Handles some JavaScript rendering server-side

The tradeoff: Jina occasionally misses content that requires browser-level JS execution. For those cases, Path B's Extractor can fall back to direct HTTP fetch, and the `search_web` tool (Tavily) handles venues where the website is entirely inaccessible.

---

## Decision 6: Knowledge graph via tag vectors, not a graph database

For the semantic layer, I had two options:

1. Use a real graph database (Neo4j, Memgraph) with typed relationships
2. Use SQLite with tag weight vectors and cosine similarity

I chose option 2. The use case is narrow: find venues that program similar content. This is well-served by computing tag frequency per venue, storing them as weight vectors in a table, and doing cosine similarity at query time. For 50–200 venues per city, this is instant.

A graph database would be worth it if the queries became more complex (multi-hop relationships, temporal patterns across runs). For V1, the overhead isn't justified.

---

## Decision 7: SSE streaming over WebSockets

The run can take 5–15 minutes. The user needs to know it's working. I used **Server-Sent Events** rather than WebSockets because:

- SSE is unidirectional (server → client), which matches the use case exactly — the frontend never sends updates back during a run
- SSE works over standard HTTP, no upgrade handshake
- SSE reconnects automatically if the connection drops
- FastAPI supports SSE natively with `StreamingResponse`

The pipeline writes progress events to a thread-safe `queue.SimpleQueue` (because `scrape_venue_node` runs in a thread pool), and the async generator drains this queue between each LangGraph chunk, yielding SSE-compatible dicts.

---

## What I'd change at scale

This is a local, single-user tool. If it needed to run for hundreds of cities continuously, several things would break or become expensive:

**Parallelism ceiling**: LangGraph's thread pool is process-local. At scale, the scrape jobs should move to a task queue (Celery, RQ, or Ray) so they can run across multiple machines.

**SQLite → Postgres**: SQLite WAL mode works well locally but doesn't support concurrent writes from multiple processes. Postgres with connection pooling would be needed.

**LLM calls without retry/backoff**: Currently, a failed LLM call returns an empty result. At scale, you'd want exponential backoff and a dead-letter queue for venues that consistently fail.

**Playbook learning is too conservative**: Right now the Playbook only records exact domain matches. A production version would detect CMS fingerprints (WordPress, Squarespace, Drupal) and apply known-working strategies cluster-wide rather than per-domain.

**Cost**: At 80 venues per city and ~$0.30 per run, cost is trivial. At 1,000 cities/day, the extraction LLM calls become the dominant cost and would need aggressive caching and batching.

---

## Stack summary

| Layer | Choice | Reason |
|---|---|---|
| Orchestration | LangGraph `StateGraph` + `Send` | DAG with stateful parallel fan-out |
| Fast scraper | `create_react_agent` ReAct loop | Autonomous tool selection, GPT-4o-mini |
| Thorough scraper | Navigator → Strategy → Extractor | Decomposed, each step independently testable |
| Page fetching | Jina Reader API | Clean markdown, token-efficient |
| Web search fallback | Tavily | Structured search results for no-website venues |
| Judge | Rules + Claude 3.5 Sonnet (borderline only) | Cost-aware: LLM only where rules are ambiguous |
| Knowledge graph | SQLite + cosine similarity | Sufficient for V1 query patterns |
| API | FastAPI + SSE | Async streaming, minimal overhead |
| Frontend | React + Vite | 4-layer dashboard, HMR for iteration speed |
| Model gateway | OpenRouter | Single API key for GPT-4o-mini + Claude Sonnet |
