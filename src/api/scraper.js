// Layer 2: Web scraping via Anthropic API + web_search tool

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Scrapes upcoming events for a single venue using Claude + web search.
 * @param {Object} venue - Venue object from venues.js
 * @returns {Array} Array of event objects
 */
export async function scrapeVenueEvents(venue) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: `You are an event scraper. Search for upcoming events at the given venue and return ONLY a JSON array (no markdown, no extra text) like:
[{"title":"Event Name","date":"2026-03-15","time":"2:00 PM - 4:00 PM","category":"Workshop","description":"Brief description","free":true}]
Return at most 5 events. If no events found, return []. Only JSON, nothing else.`,
      messages: [{
        role: "user",
        content: `Search for upcoming events at: ${venue.name}, Philadelphia. Check their website: ${venue.website}. Return the JSON array of events only.`,
      }],
    }),
  });

  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock) return [];

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

/**
 * Scrapes all venues sequentially, calling onProgress after each.
 * @param {Array} venues
 * @param {Function} onProgress - (venueId, status, events) => void
 * @returns {Array} All collected events
 */
export async function scrapeAllVenues(venues, onProgress) {
  const allEvents = [];

  for (const venue of venues) {
    onProgress(venue.id, "scraping", []);
    try {
      const events = await scrapeVenueEvents(venue);
      const tagged = events.map((ev) => ({
        ...ev,
        venue: venue.name,
        venueType: venue.type,
        venueId: venue.id,
      }));
      allEvents.push(...tagged);
      onProgress(venue.id, "done", tagged);
    } catch {
      onProgress(venue.id, "error", []);
    }
  }

  return allEvents;
}
