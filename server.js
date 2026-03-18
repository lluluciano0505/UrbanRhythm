import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3333;
const OPENROUTER_KEY = process.env.VITE_OPENROUTER_API_KEY;

// Models
const EXTRACT_MODEL = "openai/gpt-4o-mini";   // fast + cheap for structured extraction
const SEARCH_MODEL  = "perplexity/sonar";      // has live web search built-in

app.use(cors());
app.use(express.json());

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
async function callLLM(systemPrompt, userMessage, model = EXTRACT_MODEL) {
  if (!OPENROUTER_KEY) throw new Error("No VITE_OPENROUTER_API_KEY in .env");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "http://localhost:3333",
      "X-Title": "PhillyCulturalRadar",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: userMessage },
      ],
    }),
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
  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();

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

OUTPUT: ONLY a JSON array. No markdown fences, no explanation, no preamble.
If no events found, output exactly: []

Example output:
[{"title":"Jazz Night","date":"${year}-04-15","time":"8:00 PM","category":"Music","description":"Live jazz quartet performance","free":false,"event_url":"https://example.com/jazz-night"}]`;
}

// ════════════════════════════════════════════════════════════════
//  PARSE LLM RESPONSE → EVENTS ARRAY
// ════════════════════════════════════════════════════════════════
function parseEvents(raw, venueName, url) {
  if (!raw) return [];
  try {
    let clean = raw.trim();
    // Strip markdown fences
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    // Find the array
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];

    return arr
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
  } catch (err) {
    L("Parse", `JSON error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
//  FIND EVENT-RELATED LINKS from Jina's link map or markdown
// ════════════════════════════════════════════════════════════════
function findEventLinks(markdown, jinaLinks, baseUrl) {
  const found = [];
  const seen = new Set();

  const isEventLink = (text, href) => {
    const t = (text + " " + href).toLowerCase();
    return /event|calendar|schedule|show|concert|program|what.?s.?on|happen|perform|exhibit|upcoming|ticket|lineup|season/i.test(t);
  };

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
//  STRATEGY A: JINA FETCH → LLM EXTRACTION
//  Jina renders JS, returns Markdown. LLM reads it intelligently.
// ════════════════════════════════════════════════════════════════
async function strategyA(url, venueName, venueType) {
  L("A", `Jina + LLM: ${url}`);

  const { markdown, links: jinaLinks, ok, error } = await fetchWithJina(url);
  if (!ok) {
    L("A", `Jina failed: ${error}`);
    return { events: [], eventLinks: [], markdown: "" };
  }

  // Find event-related links (for Strategy B if needed)
  const eventLinks = findEventLinks(markdown, jinaLinks, url);
  L("A", `Found ${eventLinks.length} event-related links`);

  // Truncate to keep LLM costs down
  const truncated = markdown.slice(0, 10000);

  try {
    L("A", `Sending ${truncated.length} chars to ${EXTRACT_MODEL}...`);
    const llmResponse = await callLLM(
      extractionPrompt(venueName, venueType),
      `Extract all upcoming events from this webpage content:\n\n${truncated}`
    );
    L("A", `LLM response: ${llmResponse.length} chars`);

    const events = parseEvents(llmResponse, venueName, url);
    L("A", `→ ${events.length} events`);
    return { events, eventLinks, markdown };
  } catch (err) {
    L("A", `LLM error: ${err.message}`);
    return { events: [], eventLinks, markdown };
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

    const truncated = markdown.slice(0, 10000);

    try {
      L("B", `Sending ${truncated.length} chars to LLM...`);
      const llmResponse = await callLLM(
        extractionPrompt(venueName, venueType),
        `Extract events from this sub-page (${c.url}):\n\n${truncated}`
      );

      const events = parseEvents(llmResponse, venueName, c.url);
      if (events.length > 0) {
        L("B", `✅ ${events.length} events from ${c.url}`);
        return { events, source: c.url };
      }
    } catch (err) {
      L("B", `LLM error: ${err.message}`);
    }
  }

  L("B", "No events on sub-pages");
  return { events: [], source: null };
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY C: PERPLEXITY WEB SEARCH
//  Completely independent — searches the web for venue events.
//  Doesn't need Jina or HTML at all.
// ════════════════════════════════════════════════════════════════
async function strategyC(venueName, venueType, websiteUrl) {
  L("C", `Perplexity search: "${venueName}"`);

  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();

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
    const events = parseEvents(response, venueName, websiteUrl);
    L("C", `→ ${events.length} events`);
    return { events };
  } catch (err) {
    L("C", `Perplexity error: ${err.message}`);
    return { events: [] };
  }
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATOR: A → B → C
// ════════════════════════════════════════════════════════════════
async function scrapeVenue(url, venueName, venueType) {
  L("Main", `━━━ "${venueName}" → ${url}`);
  const t0 = Date.now();

  // ── Strategy A: Jina + LLM on main page ──
  try {
    const a = await strategyA(url, venueName, venueType);
    if (a.events.length > 0) {
      L("Main", `✅ A: ${a.events.length} events (${Date.now() - t0}ms)`);
      return { events: a.events, strategy: "jina-direct" };
    }

    // ── Strategy B: Jina + LLM on sub-pages ──
    if (a.eventLinks.length > 0 || a.markdown.length > 100) {
      try {
        const b = await strategyB(url, venueName, venueType, a.eventLinks);
        if (b.events.length > 0) {
          L("Main", `✅ B: ${b.events.length} events from ${b.source} (${Date.now() - t0}ms)`);
          return { events: b.events, strategy: "jina-subpage", notes: `Source: ${b.source}` };
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
    const c = await strategyC(venueName, venueType, url);
    if (c.events.length > 0) {
      L("Main", `✅ C: ${c.events.length} events via Perplexity (${Date.now() - t0}ms)`);
      return { events: c.events, strategy: "perplexity-search", notes: "Via live web search" };
    }
  } catch (err) {
    L("Main", `C error: ${err.message}`);
  }

  L("Main", `❌ All strategies empty (${Date.now() - t0}ms)`);
  return { events: [], strategy: "none", notes: "No events found" };
}

// ════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ════════════════════════════════════════════════════════════════

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
    res.json({ events: result.events, notes: result.notes, strategy: result.strategy });
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
      batch.map((v) =>
        scrapeVenue(v.website, v.name, v.type).catch((e) => ({
          events: [], strategy: "error", notes: e.message,
        }))
      )
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