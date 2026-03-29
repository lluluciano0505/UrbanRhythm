import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3333;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const API_SECRET = process.env.VITE_API_SECRET;

// Models
const EXTRACT_MODEL = "openai/gpt-4o-mini";   // fast + cheap for structured extraction
const SEARCH_MODEL  = "perplexity/sonar";      // has live web search built-in

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  if (req.path === "/api/health") return next(); // health check is public
  if (!API_SECRET) return next();               // secret not configured — skip in dev
  if (req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ════════════════════════════════════════════════════════════════
//  LOGGING
// ════════════════════════════════════════════════════════════════
const L = (tag, msg) => console.log(`  [${tag}] ${msg}`);

// ════════════════════════════════════════════════════════════════
//  JINA READER — fetches any URL as clean Markdown
//  Handles JS-rendered sites, SPAs, dynamic content
// ════════════════════════════════════════════════════════════════
async function fetchWithJina(url, timeoutMs = 25000) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  L("Jina", `Fetching: ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(jinaUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);

    const data = await res.json();
    const markdown = data.data?.content || data.content || "";
    const title = data.data?.title || data.title || "";
    const links = data.data?.links || data.links || {};

    L("Jina", `Got ${markdown.length} chars, title: "${title.slice(0, 60)}"`);
    return { markdown, title, links, ok: markdown.length > 50 };
  } catch (err) {
    L("Jina", `Failed: ${err.message}`);
    return { markdown: "", title: "", links: {}, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ════════════════════════════════════════════════════════════════
//  OPENROUTER LLM CALL
// ════════════════════════════════════════════════════════════════
async function callLLM(systemPrompt, userMessage, model = EXTRACT_MODEL, options = {}) {
  if (!OPENROUTER_KEY) throw new Error("No OPENROUTER_API_KEY in .env");

  const { responseFormat, temperature = 0.1, max_tokens = 4000 } = options;
  const body = {
    model,
    temperature,
    max_tokens,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: userMessage },
    ],
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "http://localhost:3333",
      "X-Title": "PhillyCulturalRadar",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ════════════════════════════════════════════════════════════════
//  EXTRACTION SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════
function extractionPrompt(venueName, venueType) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const year = now.getFullYear();

  return `You are an expert event extractor. You read webpage content (in Markdown) and find upcoming events.

VENUE: "${venueName}" (type: ${venueType || "unknown"})
TODAY: ${today}   YEAR: ${year}

RULES:
1. Only events on or after ${today}.
2. date MUST be YYYY-MM-DD. "March 22" with no year → ${year}. If month already passed → ${year + 1}.
3. time: "7:00 PM" format, or "TBD" if unknown.
4. category: Music / Theater / Dance / Comedy / Film / Art / Lecture / Sports / Food / Social / Workshop / Festival / Other
5. free: true ONLY if explicitly stated free/no cover/$0/donation. Default false.
6. description: max 200 chars, summarize what the event is.
7. event_url: direct link to event detail page if you can find it in the content, otherwise "".
8. Max 25 events.
9. Ignore navigation text, ads, footer links — only real events.

OUTPUT: ONLY a JSON object with one key: "events".
No markdown fences, no explanation, no preamble.
If no events found, output exactly: {"events":[]}

Example output:
{"events":[{"title":"Jazz Night","date":"${year}-04-15","time":"8:00 PM","category":"Music","description":"Live jazz quartet performance","free":false,"event_url":"https://example.com/jazz-night"}]}`;
}

// ════════════════════════════════════════════════════════════════
//  PARSE LLM RESPONSE → EVENTS ARRAY
// ════════════════════════════════════════════════════════════════
function parseEvents(raw, venueName, url) {
  if (!raw) {
    return { events: [], error: "Empty model response" };
  }

  try {
    let clean = raw.trim();
    // Strip markdown fences
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let arr = null;

    // Preferred: parse entire JSON payload (supports {"events":[...]})
    try {
      const parsedWhole = JSON.parse(clean);
      if (Array.isArray(parsedWhole)) {
        arr = parsedWhole;
      } else if (parsedWhole && Array.isArray(parsedWhole.events)) {
        arr = parsedWhole.events;
      }
    } catch {
      // Fallback below
    }

    // Fallback: try to recover a JSON array from mixed text
    if (!arr) {
      const match = clean.match(/\[[\s\S]*\]/);
      if (!match) {
        return { events: [], error: "No JSON array found in model response" };
      }
      const recovered = JSON.parse(match[0]);
      if (!Array.isArray(recovered)) {
        return { events: [], error: "Parsed JSON is not an array" };
      }
      arr = recovered;
    }

    const events = arr
      .filter((e) => e && e.title && (e.date || e.time))
      .map((e) => ({
        title: String(e.title || "").slice(0, 200),
        date: String(e.date || "").slice(0, 20),
        time: String(e.time || "TBD").slice(0, 20),
        category: String(e.category || "Other"),
        description: String(e.description || "").slice(0, 200),
        free: !!e.free,
        venue: venueName,
        url,
        event_url: String(e.event_url || ""),
      }));

    return { events, error: null };
  } catch (err) {
    L("Parse", `JSON error: ${err.message}`);
    return { events: [], error: `JSON parse failed: ${err.message}` };
  }
}

function dedupeEvents(events) {
  const seen = new Set();
  const deduped = [];

  for (const e of events) {
    const key = [
      String(e.title || "").toLowerCase().trim(),
      String(e.date || "").toLowerCase().trim(),
      String(e.time || "").toLowerCase().trim(),
      String(e.event_url || "").toLowerCase().trim(),
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
  }

  return deduped;
}

function extractEventDenseMarkdown(markdown, maxBlocks = 14) {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (!blocks.length) return "";

  const dateRegex = /(\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b)/i;
  const keywordRegex = /(event|calendar|show|concert|performance|exhibit|festival|workshop|lecture|ticket|lineup|upcoming)/i;
  const timeRegex = /(\b\d{1,2}:\d{2}\s?(?:am|pm)\b|\b\d{1,2}\s?(?:am|pm)\b)/i;

  const scored = blocks.map((text, idx) => {
    let score = 0;
    if (dateRegex.test(text)) score += 3;
    if (keywordRegex.test(text)) score += 2;
    if (timeRegex.test(text)) score += 1;
    if (text.length > 120 && text.length < 2200) score += 1;
    return { idx, text, score };
  });

  const top = scored
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBlocks)
    .sort((a, b) => a.idx - b.idx)
    .map((b) => b.text);

  return top.join("\n\n");
}

function chunkText(text, chunkSize = 6500, overlap = 600) {
  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function buildExtractionChunks(markdown, maxChunks = 4) {
  const dense = extractEventDenseMarkdown(markdown);
  const source = dense.length >= 1200 ? dense : markdown;
  return chunkText(source, 6500, 600).slice(0, maxChunks);
}

// ════════════════════════════════════════════════════════════════
//  FIND EVENT-RELATED LINKS from Jina's link map or markdown
// ════════════════════════════════════════════════════════════════
const EVENT_LINK_RE = /event|calendar|schedule|show|concert|program|what.?s.?on|happen|perform|exhibit|upcoming|ticket|lineup|season/i;
const isEventLink = (text, href) => EVENT_LINK_RE.test(text + " " + href);

function findEventLinks(markdown, jinaLinks, baseUrl) {
  const found = [];
  const seen = new Set();

  // From Jina's structured links object: { "Link Text": "url", ... }
  if (jinaLinks && typeof jinaLinks === "object") {
    for (const [text, href] of Object.entries(jinaLinks)) {
      if (isEventLink(text, href) && !seen.has(href)) {
        seen.add(href);
        found.push({ text, href });
      }
    }
  }

  // From markdown [text](url) patterns
  const mdLinkPattern = /\[([^\]]{3,80})\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdLinkPattern.exec(markdown)) !== null) {
    const [, text, href] = m;
    if (isEventLink(text, href) && !seen.has(href)) {
      seen.add(href);
      found.push({ text, href });
    }
  }

  // Filter to same domain
  try {
    const baseDomain = new URL(baseUrl).hostname;
    return found.filter((l) => {
      try { return new URL(l.href).hostname === baseDomain; } catch { return false; }
    });
  } catch {
    return found;
  }
}

// ════════════════════════════════════════════════════════════════
//  VENUE PAGE VALIDATOR
//  Checks that scraped content actually belongs to the expected venue.
//  Uses a fast string heuristic first; falls back to LLM only when ambiguous.
//  Returns { match: bool, confidence: 0-1, reason: string }
// ════════════════════════════════════════════════════════════════
async function validateVenuePage(markdown, venueName) {
  const sample = markdown.slice(0, 2000);
  const sampleLower = sample.toLowerCase();

  // Tokenise venue name — only words longer than 3 chars are meaningful
  const nameParts = venueName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (nameParts.length === 0) {
    return { match: true, confidence: 0.5, reason: "name too short to validate" };
  }

  const hits = nameParts.filter((w) => sampleLower.includes(w)).length;
  const score = hits / nameParts.length;

  // Clear pass — majority of name words present
  if (score >= 0.6) {
    L("Validate", `✅ "${venueName}" — name match ${hits}/${nameParts.length} words`);
    return { match: true, confidence: score, reason: `name match (${hits}/${nameParts.length} words)` };
  }

  // Clear fail — none of the name words appear at all
  if (hits === 0) {
    L("Validate", `❌ "${venueName}" — venue name absent from page`);
    return { match: false, confidence: 0.85, reason: "venue name absent from page content" };
  }

  // Ambiguous — partial match, ask the LLM to decide
  L("Validate", `⚠️  "${venueName}" — partial match (${hits}/${nameParts.length}), asking LLM`);
  try {
    const response = await callLLM(
      null,
      `Does this web page belong to the venue "${venueName}" in Philadelphia, PA?

Page excerpt:
${sample}

Reply with JSON only: { "match": true/false, "confidence": 0.0-1.0, "reason": "one sentence" }
Return match:false if this is a different venue, a different city's branch, or a corporate parent site unrelated to this specific location.`,
      EXTRACT_MODEL,
      { responseFormat: { type: "json_object" } }
    );
    const r = JSON.parse(response);
    L("Validate", `LLM → match=${r.match} (${r.confidence}) — ${r.reason}`);
    return {
      match: Boolean(r.match),
      confidence: Number(r.confidence) || 0.5,
      reason: r.reason || "",
    };
  } catch {
    // On error be permissive — don't silently drop legitimate scrapes
    return { match: true, confidence: 0.5, reason: "validation error — permissive fallback" };
  }
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY A: JINA FETCH → LLM EXTRACTION
//  Jina renders JS, returns Markdown. LLM reads it intelligently.
// ════════════════════════════════════════════════════════════════
async function strategyA(url, venueName, venueType) {
  L("A", `Jina + LLM: ${url}`);

  const { markdown, links: jinaLinks, ok, error } = await fetchWithJina(url);
  if (!ok) {
    L("A", `Jina failed: ${error}`);
    return { events: [], eventLinks: [], markdown: "", mismatch: false };
  }

  // Validate this page actually belongs to the expected venue
  const validation = await validateVenuePage(markdown, venueName);
  if (!validation.match && validation.confidence >= 0.7) {
    L("A", `❌ Page mismatch (conf=${validation.confidence.toFixed(2)}): ${validation.reason}`);
    return { events: [], eventLinks: [], markdown, mismatch: true, parseError: `Page mismatch: ${validation.reason}` };
  }

  // Find event-related links (for Strategy B if needed)
  const eventLinks = findEventLinks(markdown, jinaLinks, url);
  L("A", `Found ${eventLinks.length} event-related links`);

  const chunks = buildExtractionChunks(markdown, 4);
  const parseErrors = [];
  let allEvents = [];

  try {
    if (!chunks.length) {
      return { events: [], eventLinks, markdown, parseError: "No markdown content to extract" };
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      L("A", `Chunk ${i + 1}/${chunks.length}: ${chunk.length} chars → ${EXTRACT_MODEL}`);

      const llmResponse = await callLLM(
        extractionPrompt(venueName, venueType),
        `Extract all upcoming events from this webpage chunk ${i + 1}/${chunks.length}.\n\n${chunk}`,
        EXTRACT_MODEL,
        { responseFormat: { type: "json_object" } }
      );

      const parsed = parseEvents(llmResponse, venueName, url);
      if (parsed.error) {
        parseErrors.push(`chunk ${i + 1}: ${parsed.error}`);
        L("A", `Parse warning: ${parsed.error}`);
      }

      allEvents.push(...parsed.events);
    }

    allEvents = dedupeEvents(allEvents).slice(0, 25);
    L("A", `→ ${allEvents.length} events`);
    return {
      events: allEvents,
      eventLinks,
      markdown,
      parseError: parseErrors.length ? parseErrors.join(" | ") : null,
    };
  } catch (err) {
    L("A", `LLM error: ${err.message}`);
    return { events: [], eventLinks, markdown, parseError: null };
  }
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY B: EXPLORE SUB-PAGES via Jina + LLM
//  If main page had no events, try /events, /calendar, etc.
// ════════════════════════════════════════════════════════════════
async function strategyB(baseUrl, venueName, venueType, knownLinks = []) {
  L("B", `Sub-page exploration for ${baseUrl}`);

  const origin = new URL(baseUrl).origin;
  const seen = new Set([baseUrl]);
  const candidates = [];
  const parseErrors = [];

  // Priority 1: event links found on main page
  for (const link of knownLinks.slice(0, 5)) {
    const href = link.href;
    if (!seen.has(href)) {
      seen.add(href);
      candidates.push({ url: href, reason: `link: "${link.text}"` });
    }
  }

  // Priority 2: common event paths
  for (const p of [
    "/events", "/calendar", "/shows", "/whats-on", "/schedule",
    "/upcoming", "/performances", "/exhibitions", "/programs",
  ]) {
    const url = origin + p;
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push({ url, reason: `common: ${p}` });
    }
  }

  // Try each (max 4 to keep it fast)
  for (const c of candidates.slice(0, 4)) {
    L("B", `Trying: ${c.url} (${c.reason})`);

    const { markdown, ok } = await fetchWithJina(c.url, 15000);
    if (!ok || markdown.length < 100) continue;

    // Validate sub-page belongs to the expected venue before burning extraction tokens
    const validation = await validateVenuePage(markdown, venueName);
    if (!validation.match && validation.confidence >= 0.7) {
      L("B", `❌ Sub-page mismatch: ${validation.reason}`);
      continue;
    }

    const chunks = buildExtractionChunks(markdown, 2);

    try {
      if (!chunks.length) continue;

      let events = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        L("B", `Chunk ${i + 1}/${chunks.length}: ${chunk.length} chars from ${c.url}`);

        const llmResponse = await callLLM(
          extractionPrompt(venueName, venueType),
          `Extract events from this sub-page (${c.url}), chunk ${i + 1}/${chunks.length}:\n\n${chunk}`,
          EXTRACT_MODEL,
          { responseFormat: { type: "json_object" } }
        );

        const parsed = parseEvents(llmResponse, venueName, c.url);
        if (parsed.error) {
          parseErrors.push(`${c.url} chunk ${i + 1}: ${parsed.error}`);
          L("B", `Parse warning: ${parsed.error}`);
        }
        events.push(...parsed.events);
      }

      events = dedupeEvents(events).slice(0, 25);
      if (events.length > 0) {
        L("B", `✅ ${events.length} events from ${c.url}`);
        return { events, source: c.url, parseError: parseErrors.length ? parseErrors.join(" | ") : null };
      }
    } catch (err) {
      L("B", `LLM error: ${err.message}`);
    }
  }

  L("B", "No events on sub-pages");
  return {
    events: [],
    source: null,
    parseError: parseErrors.length ? parseErrors.join(" | ") : null,
  };
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY C: PERPLEXITY WEB SEARCH
//  Completely independent — searches the web for venue events.
//  Doesn't need Jina or HTML at all.
// ════════════════════════════════════════════════════════════════
async function strategyC(venueName, websiteUrl) {
  L("C", `Perplexity search: "${venueName}"`);

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const year = now.getFullYear();

  const prompt = `Search the web and find upcoming events at "${venueName}" in Philadelphia, PA.
Their website is: ${websiteUrl}

Look for their current schedule of shows, concerts, performances, exhibitions, classes, workshops, or any events happening on or after ${today}.

Return ONLY a JSON array with this exact format (no markdown, no explanation):
[
  {
    "title": "Event Name",
    "date": "${year}-MM-DD",
    "time": "7:30 PM",
    "category": "Music",
    "description": "Brief description, max 200 chars",
    "free": false,
    "event_url": "https://direct-link-to-event"
  }
]

If you can't find any events, return exactly: []`;

  try {
    const response = await callLLM(null, prompt, SEARCH_MODEL);
    L("C", `Perplexity response: ${response.length} chars`);
    const parsed = parseEvents(response, venueName, websiteUrl);
    if (parsed.error) L("C", `Parse warning: ${parsed.error}`);
    const events = parsed.events;
    L("C", `→ ${events.length} events`);
    return { events, parseError: parsed.error };
  } catch (err) {
    L("C", `Perplexity error: ${err.message}`);
    return { events: [], parseError: null };
  }
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATOR: A → B → C
// ════════════════════════════════════════════════════════════════
async function scrapeVenue(url, venueName, venueType) {
  L("Main", `━━━ "${venueName}" → ${url}`);
  const t0 = Date.now();
  const parseErrors = [];

  // ── Strategy A: Jina + LLM on main page ──
  try {
    const a = await strategyA(url, venueName, venueType);
    if (a.parseError) parseErrors.push(`A: ${a.parseError}`);
    if (a.events.length > 0) {
      L("Main", `✅ A: ${a.events.length} events (${Date.now() - t0}ms)`);
      return {
        events: a.events,
        strategy: "jina-direct",
        parseErrors: parseErrors.length ? parseErrors : undefined,
      };
    }

    // ── Strategy B: Jina + LLM on sub-pages ──
    // Skip B if A confirmed the whole domain is wrong (sub-pages share the same domain)
    if (!a.mismatch && (a.eventLinks.length > 0 || a.markdown.length > 100)) {
      try {
        const b = await strategyB(url, venueName, venueType, a.eventLinks);
        if (b.parseError) parseErrors.push(`B: ${b.parseError}`);
        if (b.events.length > 0) {
          L("Main", `✅ B: ${b.events.length} events from ${b.source} (${Date.now() - t0}ms)`);
          return {
            events: b.events,
            strategy: "jina-subpage",
            notes: `Source: ${b.source}`,
            parseErrors: parseErrors.length ? parseErrors : undefined,
          };
        }
      } catch (err) {
        L("Main", `B error: ${err.message}`);
      }
    }
  } catch (err) {
    L("Main", `A error: ${err.message}`);
  }

  // ── Strategy C: Perplexity web search ──
  try {
    const c = await strategyC(venueName, url);
    if (c.parseError) parseErrors.push(`C: ${c.parseError}`);
    if (c.events.length > 0) {
      L("Main", `✅ C: ${c.events.length} events via Perplexity (${Date.now() - t0}ms)`);
      return {
        events: c.events,
        strategy: "perplexity-search",
        notes: "Via live web search",
        parseErrors: parseErrors.length ? parseErrors : undefined,
      };
    }
  } catch (err) {
    L("Main", `C error: ${err.message}`);
  }

  L("Main", `❌ All strategies empty (${Date.now() - t0}ms)`);
  return {
    events: [],
    strategy: "none",
    notes: parseErrors.length ? "No events found (with parse warnings)" : "No events found",
    parseErrors: parseErrors.length ? parseErrors : undefined,
  };
}

// ════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ════════════════════════════════════════════════════════════════

// Generates a multi-query Google Maps search plan from a user query
app.post("/api/search-plan", async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: "query required" });

  const fallback = {
    queries: [query.toLowerCase().includes("philadelphia") ? query : `${query} Philadelphia`],
    placeTypes: [],
    seedTags: query.toLowerCase().split(/\s+/),
  };

  try {
    const content = await callLLM(
      null,
      `You are a search strategy planner for finding venues in Philadelphia.

User query: "${query}"

Generate a search plan as JSON with these fields:
1. "queries" — array of 3-5 different Google Maps text search queries (each max 6 words, must include "Philadelphia"). Cover different angles:
   - Direct interpretation
   - Related venue types
   - Neighborhood-specific
   - Broader category

2. "placeTypes" — array of Google Places type strings relevant to the intent. Valid types include: bar, night_club, restaurant, cafe, museum, art_gallery, library, park, stadium, movie_theater, performing_arts_theater, book_store, bowling_alley, gym, amusement_park, tourist_attraction.
   Pick 2-4 that best match.

3. "seedTags" — array of 3-6 lowercase keywords to match against a local venue database tags. Think about what tags a relevant venue might have.

Return ONLY valid JSON, no markdown fences.`,
      "openai/gpt-4-turbo",
      { temperature: 0.3, max_tokens: 400 }
    );
    const plan = JSON.parse(content.replace(/```json|```/g, "").trim());
    res.json({
      queries: Array.isArray(plan.queries) ? plan.queries.slice(0, 5) : fallback.queries,
      placeTypes: Array.isArray(plan.placeTypes) ? plan.placeTypes.slice(0, 4) : [],
      seedTags: Array.isArray(plan.seedTags) ? plan.seedTags.slice(0, 6) : fallback.seedTags,
    });
  } catch (err) {
    console.error("search-plan error:", err.message);
    res.json(fallback);
  }
});

// Semantic venue filter — returns only venue IDs relevant to the query
app.post("/api/filter-venues", async (req, res) => {
  const { query, venues } = req.body;
  if (!query || !Array.isArray(venues) || !venues.length) {
    return res.status(400).json({ error: "query and venues[] required" });
  }

  try {
    const content = await callLLM(
      null,
      `You are a strict relevance filter for venue search results in Philadelphia.

User query: "${query}"

IMPORTANT:
- A venue does NOT need the keyword in its name. A bar that hosts live music IS a concert venue.
- Include venues that COULD reasonably host or relate to the queried activity.
- When in doubt, INCLUDE rather than exclude.

Places (id | name | type | address):
${venues.map((v) => `${v.id} | ${v.name} | ${v.type} | ${v.address}`).join("\n")}

Return ONLY JSON array of relevant ids: ["id1","id2"]`,
      "openai/gpt-4-turbo",
      { temperature: 0.2, max_tokens: 800 }
    );
    const ids = JSON.parse(content.replace(/```json|```/g, "").trim());
    if (!Array.isArray(ids) || !ids.length) return res.json({ ids: null });
    res.json({ ids: ids.map(String) });
  } catch (err) {
    console.error("filter-venues error:", err.message);
    res.json({ ids: null }); // frontend falls back to unfiltered on null
  }
});

app.post("/api/scrape-venue", async (req, res) => {
  const { name, website, type } = req.body;

  console.log(`\n${"═".repeat(55)}`);
  console.log(`🕷️  ${name}`);
  console.log(`   ${website} (${type || "unknown"})`);
  console.log(`${"═".repeat(55)}`);

  if (!website?.startsWith("http")) {
    return res.json({ events: [], debug: "Invalid URL" });
  }

  try {
    const result = await scrapeVenue(website, name, type);
    console.log(`✅ ${result.events.length} events [${result.strategy}]\n`);
    res.json({
      events: result.events,
      notes: result.notes,
      strategy: result.strategy,
      parseErrors: result.parseErrors,
    });
  } catch (err) {
    console.error(`❌ Fatal:`, err);
    res.status(500).json({ events: [], debug: err.message });
  }
});

app.post("/api/scrape-batch", async (req, res) => {
  const { venues } = req.body;
  if (!Array.isArray(venues) || !venues.length) {
    return res.status(400).json({ error: "venues[] required" });
  }

  console.log(`\n🔄 Batch: ${venues.length} venues`);
  const results = [];

  // 2 at a time to respect Jina + OpenRouter rate limits
  for (let i = 0; i < venues.length; i += 2) {
    const batch = venues.slice(i, i + 2);
    const settled = await Promise.allSettled(
      batch.map((v) => scrapeVenue(v.website, v.name, v.type))
    );

    settled.forEach((r, idx) => {
      const v = batch[idx];
      const val = r.status === "fulfilled" ? r.value : { events: [], notes: r.reason?.message };
      results.push({
        venue: v.name,
        website: v.website,
        events: val.events || [],
        strategy: val.strategy || "error",
        notes: val.notes || "",
        parseErrors: val.parseErrors,
      });
    });

    if (i + 2 < venues.length) await new Promise((r) => setTimeout(r, 1200));
  }

  const total = results.reduce((s, r) => s + r.events.length, 0);
  console.log(`✅ Batch: ${total} events from ${venues.length} venues\n`);
  res.json({ results, totalEvents: total });
});

// ── Diagnostic endpoint ──
app.get("/api/test", async (req, res) => {
  console.log("\n🧪 Running diagnostics...\n");
  const results = {
    timestamp: new Date().toISOString(),
    jina: { status: "testing..." },
    openrouter: { status: "testing..." },
    perplexity: { status: "testing..." },
    pipeline: { status: "testing..." },
  };

  // Test Jina Reader
  try {
    const j = await fetchWithJina("https://www.freelibrary.org/events", 15000);
    results.jina = {
      status: j.ok ? "✅ working" : `❌ ${j.error}`,
      contentLength: j.markdown.length,
      preview: j.markdown.slice(0, 200),
    };
  } catch (err) {
    results.jina = { status: `❌ ${err.message}` };
  }

  // Test OpenRouter (extraction model)
  try {
    const r = await callLLM("Reply with just OK", "Say OK", EXTRACT_MODEL);
    results.openrouter = {
      status: "✅ working",
      model: EXTRACT_MODEL,
      response: r.slice(0, 50),
    };
  } catch (err) {
    results.openrouter = { status: `❌ ${err.message}`, model: EXTRACT_MODEL };
  }

  // Test Perplexity (search model)
  try {
    const r = await callLLM(null, "What is today's date?", SEARCH_MODEL);
    results.perplexity = {
      status: "✅ working",
      model: SEARCH_MODEL,
      response: r.slice(0, 100),
    };
  } catch (err) {
    results.perplexity = { status: `❌ ${err.message}`, model: SEARCH_MODEL };
  }

  // Test full pipeline on a real venue
  try {
    const p = await scrapeVenue(
      "https://www.fillmorephilly.com",
      "The Fillmore Philadelphia",
      "concert_hall"
    );
    results.pipeline = {
      status: p.events.length > 0 ? "✅ working" : "⚠️ no events found",
      eventsFound: p.events.length,
      strategy: p.strategy,
      sample: p.events[0] || null,
    };
  } catch (err) {
    results.pipeline = { status: `❌ ${err.message}` };
  }

  console.log("🧪 Done:", JSON.stringify(results, null, 2));
  res.json(results);
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    extractModel: EXTRACT_MODEL,
    searchModel: SEARCH_MODEL,
    timestamp: new Date().toISOString(),
    hasOpenRouterKey: !!OPENROUTER_KEY,
  });
});

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
🕷️  Event Scraper v4 — http://localhost:${PORT}
   ─────────────────────────────────────────────
   POST /api/scrape-venue   Scrape one venue
   POST /api/scrape-batch   Scrape multiple
   GET  /api/test           🧪 Full diagnostic
   GET  /api/health         Health check

   OpenRouter Key: ${OPENROUTER_KEY ? "✅ set" : "❌ MISSING"}

   Pipeline:
     A) Jina Reader → ${EXTRACT_MODEL} extraction
        (Jina renders JS, returns Markdown → LLM reads it)
     B) Jina sub-page crawl → ${EXTRACT_MODEL}
        (tries /events, /calendar, detected links)
     C) ${SEARCH_MODEL} live web search
        (nuclear option — searches the internet directly)

   👉 http://localhost:${PORT}/api/test to verify everything
  `);
});