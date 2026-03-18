import { useState, useCallback, useEffect, useRef } from "react";
import { GoogleMap, MarkerF, useJsApiLoader } from "@react-google-maps/api";

const LAYER_LABELS = ["L1", "L2", "L3", "L4"];
const LAYER_NAMES = ["Geo-Indexing", "Event Scraping", "Data Archive", "Venue Database"];
const GOOGLE_MAPS_LIBRARIES = ["places"];
const STORAGE_KEY = "venue-archive-db";
const EVENT_STORAGE_KEY = "event-archive-db";

// ═══════════════════════════════════════════════════════════════
//  PERSISTENT VENUE ARCHIVE — replaces hardcoded seed list
//  Uses window.storage for cross-session persistence.
//  Each venue: { id, name, address, lat, lng, type, tags[],
//                rating, website, notes, archivedAt }
// ═══════════════════════════════════════════════════════════════

async function loadArchive() {
  try {
    const result = await window.storage.get(STORAGE_KEY);
    return result ? JSON.parse(result.value) : [];
  } catch {
    return [];
  }
}

async function saveArchive(venues) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(venues));
    return true;
  } catch (err) {
    console.error("Archive save failed:", err);
    return false;
  }
}

async function loadEventArchive() {
  try {
    const result = await window.storage.get(EVENT_STORAGE_KEY);
    return result ? JSON.parse(result.value) : {};
  } catch {
    return {};
  }
}

async function saveEventArchive(eventArchive) {
  try {
    await window.storage.set(EVENT_STORAGE_KEY, JSON.stringify(eventArchive));
    return true;
  } catch (err) {
    console.error("Event archive save failed:", err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════

const formatTypeLabel = (type) =>
  (type || "venue")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());

const hashColor = (input) => {
  const str = input || "venue";
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
};

const makeId = () => `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ═══════════════════════════════════════════════════════════════
//  SEARCH PLAN GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateSearchPlan(userQuery) {
  const openRouterApiKey = import.meta.env.VITE_OPENROUTER_API_KEY || "";
  const fallbackPlan = {
    queries: [userQuery.toLowerCase().includes("philadelphia") ? userQuery : `${userQuery} Philadelphia`],
    placeTypes: [],
    seedTags: userQuery.toLowerCase().split(/\s+/)
  };

  if (!openRouterApiKey) return fallbackPlan;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openRouterApiKey}` },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        temperature: 0.3,
        max_tokens: 400,
        messages: [{
          role: "user",
          content: `You are a search strategy planner for finding venues in Philadelphia.

User query: "${userQuery}"

Generate a search plan as JSON with these fields:
1. "queries" — array of 3-5 different Google Maps text search queries (each max 6 words, must include "Philadelphia"). Cover different angles:
   - Direct interpretation
   - Related venue types
   - Neighborhood-specific
   - Broader category

2. "placeTypes" — array of Google Places type strings relevant to the intent. Valid types include: bar, night_club, restaurant, cafe, museum, art_gallery, library, park, stadium, movie_theater, performing_arts_theater, book_store, bowling_alley, gym, amusement_park, tourist_attraction.
   Pick 2-4 that best match.

3. "seedTags" — array of 3-6 lowercase keywords to match against a local venue database tags. Think about what tags a relevant venue might have.

Return ONLY valid JSON, no markdown fences.`
        }]
      })
    });

    if (!response.ok) return fallbackPlan;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return fallbackPlan;

    const plan = JSON.parse(content.replace(/```json|```/g, "").trim());
    return {
      queries: Array.isArray(plan.queries) ? plan.queries.slice(0, 5) : fallbackPlan.queries,
      placeTypes: Array.isArray(plan.placeTypes) ? plan.placeTypes.slice(0, 4) : [],
      seedTags: Array.isArray(plan.seedTags) ? plan.seedTags.slice(0, 6) : fallbackPlan.seedTags
    };
  } catch (error) {
    console.error("Search plan error:", error.message);
    return fallbackPlan;
  }
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGY 1: Multi-query textSearch fan-out
// ═══════════════════════════════════════════════════════════════

async function textSearchMulti(queries, placesService) {
  if (!placesService) return [];
  const phillyCenter = new window.google.maps.LatLng(39.9526, -75.1652);
  const results = await Promise.all(queries.map(query =>
    new Promise((resolve) => {
      placesService.textSearch({ query, location: phillyCenter, radius: 20000 }, (r, s) => {
        resolve(s === window.google.maps.places.PlacesServiceStatus.OK && r ? r.slice(0, 20) : []);
      });
    })
  ));
  return results.flat();
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGY 2: nearbySearch by Google Places type
// ═══════════════════════════════════════════════════════════════

async function nearbySearchByTypes(placeTypes, placesService) {
  if (!placesService || !placeTypes.length) return [];
  const phillyCenter = new window.google.maps.LatLng(39.9526, -75.1652);
  const results = await Promise.all(placeTypes.map(type =>
    new Promise((resolve) => {
      placesService.nearbySearch({ location: phillyCenter, radius: 15000, type }, (r, s) => {
        resolve(s === window.google.maps.places.PlacesServiceStatus.OK && r ? r.slice(0, 25) : []);
      });
    })
  ));
  return results.flat();
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGY 3: Match from user's own archived venue database
// ═══════════════════════════════════════════════════════════════

function matchArchivedVenues(seedTags, userQuery, archive) {
  if (!archive.length) return [];
  const queryLower = userQuery.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  return archive.filter(venue => {
    const venueTags = venue.tags || [];
    const tagMatch = seedTags.some(tag =>
      venueTags.some(vTag => vTag.includes(tag) || tag.includes(vTag))
    );
    const nameMatch = queryWords.some(w => venue.name.toLowerCase().includes(w));
    const typeMatch = queryWords.some(w => (venue.type || "").includes(w));
    return tagMatch || nameMatch || typeMatch;
  }).map(venue => ({
    ...venue,
    color: hashColor(venue.type),
    source: "archive"
  }));
}

// ═══════════════════════════════════════════════════════════════
//  DEDUPLICATION & ENRICHMENT
// ═══════════════════════════════════════════════════════════════

function deduplicateVenues(venues) {
  const seen = new Map();
  for (const v of venues) {
    const nameKey = v.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const latKey = v.lat ? Math.round(v.lat * 1000) : 0;
    const lngKey = v.lng ? Math.round(v.lng * 1000) : 0;
    const key = `${nameKey}_${latKey}_${lngKey}`;
    if (!seen.has(key)) {
      seen.set(key, v);
    } else {
      const existing = seen.get(key);
      if (v.website && !existing.website) seen.set(key, { ...v, source: existing.source || v.source });
    }
  }
  return Array.from(seen.values());
}

async function enrichWithDetails(rawPlaces, placesService) {
  if (!placesService) return [];
  const seenIds = new Set();
  const unique = rawPlaces.filter(p => {
    if (!p.place_id || seenIds.has(p.place_id)) return !p.place_id;
    seenIds.add(p.place_id);
    return true;
  }).slice(0, 25);

  const detailed = await Promise.all(unique.map(place =>
    new Promise((res) => {
      if (!place.place_id) { res(place); return; }
      placesService.getDetails(
        { placeId: place.place_id, fields: ["name", "formatted_address", "geometry", "rating", "website", "types", "place_id"] },
        (d, s) => res(s === window.google.maps.places.PlacesServiceStatus.OK && d ? d : place)
      );
    })
  ));

  return detailed.map((place, i) => {
    const lat = Number(typeof place.geometry?.location?.lat === "function" ? place.geometry.location.lat() : place.geometry?.location?.lat);
    const lng = Number(typeof place.geometry?.location?.lng === "function" ? place.geometry.location.lng() : place.geometry?.location?.lng);
    const type = (place.types || [])[0] || "venue";
    return {
      id: place.place_id || `p_${i}`,
      type, name: place.name || "Unknown",
      address: place.formatted_address || place.vicinity || "",
      lat: Number.isFinite(lat) ? lat : 0,
      lng: Number.isFinite(lng) ? lng : 0,
      rating: place.rating || 4.3,
      website: place.website || "",
      color: hashColor(type),
      source: "google"
    };
  }).filter(v => v.lat && v.lng);
}

// ═══════════════════════════════════════════════════════════════
//  LLM SEMANTIC FILTER
// ═══════════════════════════════════════════════════════════════

async function filterVenuesByIntent(query, venues) {
  if (!venues.length) return venues;
  const openRouterApiKey = import.meta.env.VITE_OPENROUTER_API_KEY || "";
  if (!openRouterApiKey) return venues;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openRouterApiKey}` },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        temperature: 0.2,
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `You are a strict relevance filter for venue search results in Philadelphia.

User query: "${query}"

IMPORTANT:
- A venue does NOT need the keyword in its name. A bar that hosts live music IS a concert venue.
- Include venues that COULD reasonably host or relate to the queried activity.
- When in doubt, INCLUDE rather than exclude.

Places (id | name | type | address):
${venues.map(v => `${v.id} | ${v.name} | ${v.type} | ${v.address}`).join("\n")}

Return ONLY JSON array of relevant ids: ["id1","id2"]`
        }]
      })
    });

    if (!response.ok) return venues;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return venues;

    const ids = JSON.parse(content.replace(/```json|```/g, "").trim());
    if (!Array.isArray(ids) || !ids.length) return venues;
    const idSet = new Set(ids.map(String));
    const filtered = venues.filter(v => idSet.has(String(v.id)));
    return filtered.length > 0 ? filtered : venues;
  } catch {
    return venues;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN SEARCH ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

async function searchVenues(query, placesService, archive, onProgress) {
  if (!query?.trim()) return { venues: [], error: "Empty query", source: "none" };
  const progress = onProgress || (() => {});

  progress("Generating search plan…");
  const plan = await generateSearchPlan(query);

  progress(`Fan-out: ${plan.queries.length} text + ${plan.placeTypes.length} type + archive…`);
  const [textResults, nearbyResults, archiveResults] = await Promise.all([
    textSearchMulti(plan.queries, placesService).catch(() => []),
    nearbySearchByTypes(plan.placeTypes, placesService).catch(() => []),
    Promise.resolve(matchArchivedVenues(plan.seedTags, query, archive))
  ]);

  // If results are too few, add the original query as a direct textSearch
  let additionalResults = [];
  const totalResults = textResults.length + nearbyResults.length + archiveResults.length;
  if (totalResults < 10) {
    progress("Supplemental search…");
    additionalResults = await new Promise((resolve) => {
      placesService.textSearch({ query, location: new window.google.maps.LatLng(39.9526, -75.1652), radius: 20000 }, (r, s) => {
        resolve(s === window.google.maps.places.PlacesServiceStatus.OK && r ? r.slice(0, 25) : []);
      });
    });
  }

  progress("Enriching details…");
  const enrichedGoogle = await enrichWithDetails([...textResults, ...nearbyResults, ...additionalResults], placesService);
  const allVenues = [...enrichedGoogle, ...archiveResults];
  const deduped = deduplicateVenues(allVenues);

  progress("Semantic filtering…");
  const filtered = await filterVenuesByIntent(query, deduped);

  return {
    venues: filtered, error: null, source: "multi",
    stats: { textResults: textResults.length, nearbyResults: nearbyResults.length, archiveResults: archiveResults.length, preFilter: deduped.length, postFilter: filtered.length }
  };
}

// ═══════════════════════════════════════════════════════════════
//  EVENT SCRAPING
// ═══════════════════════════════════════════════════════════════

async function scrapeVenueEvents(venue) {
  // 调用后端爬虫 API
  if (!venue.website) {
    console.warn(`⚠️  ${venue.name} has no website URL - skipping`);
    return [];
  }

  console.log(`🕷️  Scraping ${venue.name}: ${venue.website}`);

  try {
    const response = await fetch("http://localhost:3333/api/scrape-venue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: venue.name,
        website: venue.website || "",
        type: venue.type || ""
      })
    });

    if (!response.ok) {
      console.error(`❌ Backend error: ${response.status}`);
      return [];
    }
    const data = await response.json();
    const events = (data.events || []).filter(e => e.title && e.date);
    console.log(`✅ ${venue.name}: found ${events.length} events`);
    
    // 返回爬虫获取的事件，过滤掉空结果
    return events;
  } catch (err) {
    console.error(`❌ Failed to scrape ${venue.name}:`, err.message);
    console.error(`   Is backend running on http://localhost:3333?`);
    // 如果后端不可用，返回空
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  VENUE EDIT MODAL COMPONENT
// ═══════════════════════════════════════════════════════════════

function VenueModal({ venue, onSave, onClose, title }) {
  const [form, setForm] = useState({
    name: venue?.name || "",
    address: venue?.address || "",
    lat: venue?.lat || "",
    lng: venue?.lng || "",
    type: venue?.type || "venue",
    tags: (venue?.tags || []).join(", "),
    rating: venue?.rating || "",
    website: venue?.website || "",
    notes: venue?.notes || ""
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (!form.name.trim()) return;
    onSave({
      ...venue,
      id: venue?.id || makeId(),
      name: form.name.trim(),
      address: form.address.trim(),
      lat: parseFloat(form.lat) || 0,
      lng: parseFloat(form.lng) || 0,
      type: form.type.trim() || "venue",
      tags: form.tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean),
      rating: parseFloat(form.rating) || 0,
      website: form.website.trim(),
      notes: form.notes.trim(),
      archivedAt: venue?.archivedAt || new Date().toISOString()
    });
  };

  const fieldStyle = {
    width: "100%", padding: "8px 10px", fontSize: 12, background: "#F8FAFC",
    border: "1px solid #E2E8F0", borderRadius: 3, color: "#0F172A",
    fontFamily: "'DM Mono', monospace", boxSizing: "border-box"
  };
  const labelStyle = { fontSize: 10, color: "#64748B", marginBottom: 3, letterSpacing: "0.05em", display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 6, width: 480, maxHeight: "85vh", overflow: "auto", padding: 0 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", fontFamily: "'Syne', sans-serif", fontSize: 14, fontWeight: 700 }}>
          {title || "Edit Venue"}
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>NAME *</label>
            <input style={fieldStyle} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Venue name" />
          </div>
          <div>
            <label style={labelStyle}>ADDRESS</label>
            <input style={fieldStyle} value={form.address} onChange={e => set("address", e.target.value)} placeholder="Full address" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>LATITUDE</label>
              <input style={fieldStyle} type="number" step="any" value={form.lat} onChange={e => set("lat", e.target.value)} placeholder="39.9526" />
            </div>
            <div>
              <label style={labelStyle}>LONGITUDE</label>
              <input style={fieldStyle} type="number" step="any" value={form.lng} onChange={e => set("lng", e.target.value)} placeholder="-75.1652" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>TYPE</label>
              <input style={fieldStyle} value={form.type} onChange={e => set("type", e.target.value)} placeholder="bar, museum, night_club…" />
            </div>
            <div>
              <label style={labelStyle}>RATING</label>
              <input style={fieldStyle} type="number" step="0.1" min="0" max="5" value={form.rating} onChange={e => set("rating", e.target.value)} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>TAGS <span style={{ color: "#94A3B8" }}>(comma-separated — used for search matching)</span></label>
            <input style={fieldStyle} value={form.tags} onChange={e => set("tags", e.target.value)} placeholder="live music, concert, indie, bar" />
          </div>
          <div>
            <label style={labelStyle}>WEBSITE</label>
            <input style={fieldStyle} value={form.website} onChange={e => set("website", e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <label style={labelStyle}>NOTES</label>
            <textarea style={{ ...fieldStyle, minHeight: 60, resize: "vertical" }} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Personal notes…" />
          </div>
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid #E2E8F0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: "8px 16px", fontSize: 11, background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3, color: "#64748B", cursor: "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button onClick={handleSave}
            style={{ padding: "8px 16px", fontSize: 11, background: "#1D4ED8", border: "none", borderRadius: 3, color: "#FFFFFF", cursor: "pointer", fontFamily: "inherit", opacity: form.name.trim() ? 1 : 0.4 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function PhillyEventScraper() {
  const [layer, setLayer] = useState(0);
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [scrapeStatus, setScrapeStatus] = useState({});
  const [allEvents, setAllEvents] = useState([]);
  const [scraping, setScraping] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [venues, setVenues] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchProgress, setSearchProgress] = useState("");
  const [searchStats, setSearchStats] = useState(null);
  const [mapInstance, setMapInstance] = useState(null);

  // Archive state
  const [archive, setArchive] = useState([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [eventArchive, setEventArchive] = useState({});
  const [eventArchiveLoaded, setEventArchiveLoaded] = useState(false);
  const [modalVenue, setModalVenue] = useState(null);
  const [modalMode, setModalMode] = useState(null);
  const [archiveFilter, setArchiveFilter] = useState("");
  const [archiveTagFilter, setArchiveTagFilter] = useState("all");
  const [selectedArchiveVenue, setSelectedArchiveVenue] = useState(null);

  const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey, libraries: GOOGLE_MAPS_LIBRARIES });

  // Load archive on mount
  useEffect(() => {
    loadArchive().then(data => { setArchive(data); setArchiveLoaded(true); });
  }, []);

  useEffect(() => {
    loadEventArchive().then(data => { setEventArchive(data); setEventArchiveLoaded(true); });
  }, []);

  // Persist archive on change
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    if (archiveLoaded) saveArchive(archive);
  }, [archive, archiveLoaded]);

  useEffect(() => {
    if (eventArchiveLoaded) saveEventArchive(eventArchive);
  }, [eventArchive, eventArchiveLoaded]);

  // Archive CRUD
  const archiveVenue = useCallback((venue) => {
    const entry = {
      id: venue.id || makeId(),
      name: venue.name, address: venue.address || "",
      lat: venue.lat || 0, lng: venue.lng || 0,
      type: venue.type || "venue", tags: venue.tags || [],
      rating: venue.rating || 0, website: venue.website || "",
      notes: venue.notes || "", archivedAt: new Date().toISOString()
    };
    setArchive(prev => {
      if (prev.some(v => v.name.toLowerCase() === entry.name.toLowerCase())) return prev;
      return [...prev, entry];
    });
  }, []);

  const updateArchivedVenue = useCallback((updated) => {
    setArchive(prev => prev.map(v => v.id === updated.id ? updated : v));
  }, []);

  const deleteArchivedVenue = useCallback((id) => {
    setArchive(prev => prev.filter(v => v.id !== id));
  }, []);

  const isArchived = useCallback((name) => {
    return archive.some(v => v.name.toLowerCase() === (name || "").toLowerCase());
  }, [archive]);

  // Search
  const handleSearch = useCallback(async (query) => {
    setSearching(true); setSearchError(""); setSearchProgress(""); setSearchStats(null);
    setFilterType("all");
    setFilterCat("all");
    setMinRating(0);
    setSelectedVenue(null);
    try {
      const placesService = mapInstance
        ? new window.google.maps.places.PlacesService(mapInstance)
        : (window.google?.maps?.places ? new window.google.maps.places.PlacesService(document.createElement("div")) : null);
      const result = await searchVenues(query, placesService, archive, setSearchProgress);
      setVenues(result.venues || []);
      setSearchStats(result.stats || null);
      if (result.error) setSearchError(result.error);
      setHasSearched(true);
    } catch (error) {
      setVenues([]); setSearchError(error.message || "Search error");
    } finally {
      setSearching(false); setSearchProgress("");
    }
  }, [mapInstance, archive]);

  const startScraping = useCallback(async () => {
    setScraping(true); setAllEvents([]); setScrapeStatus({});
    const results = [];
    const concurrency = 4;
    const queue = [...venues];
    const scrapedVenues = [];

    const processVenue = async (venue) => {
      setScrapeStatus(s => ({ ...s, [venue.id]: "scraping" }));
      try {
        const cached = eventArchive[String(venue.id)];
        const events = cached?.events?.length ? cached.events : await scrapeVenueEvents(venue);
        setScrapeStatus(s => ({ ...s, [venue.id]: "done" }));
        if (events.length > 0) {
          events.forEach(ev => results.push({ ...ev, venue: venue.name, venueType: venue.type, venueId: venue.id }));
          scrapedVenues.push(venue);
          if (!cached) {
            setEventArchive(prev => ({
              ...prev,
              [String(venue.id)]: {
                venueId: venue.id,
                venueName: venue.name,
                venueType: venue.type,
                events,
                scrapedAt: new Date().toISOString()
              }
            }));
          }
          setAllEvents([...results]);
        }
      } catch {
        setScrapeStatus(s => ({ ...s, [venue.id]: "error" }));
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => (async () => {
      while (queue.length) {
        const venue = queue.shift();
        if (venue) {
          await processVenue(venue);
        }
      }
    })());

    await Promise.all(workers);
    
    // Add all scraped venues to the archive
    scrapedVenues.forEach(venue => archiveVenue(venue));
    
    setScraping(false); setLayer(2);
  }, [venues, eventArchive, archiveVenue]);

  const scrapeSingleVenue = useCallback(async (venue) => {
    if (!venue) return;
    setScrapeStatus(s => ({ ...s, [venue.id]: "scraping" }));
    try {
      const events = await scrapeVenueEvents(venue);
      setScrapeStatus(s => ({ ...s, [venue.id]: "done" }));
      if (events.length > 0) {
        setEventArchive(prev => ({
          ...prev,
          [String(venue.id)]: {
            venueId: venue.id,
            venueName: venue.name,
            venueType: venue.type,
            events,
            scrapedAt: new Date().toISOString()
          }
        }));
        const merged = [...allEvents, ...events.map(ev => ({ ...ev, venue: venue.name, venueType: venue.type, venueId: venue.id }))];
        setAllEvents(merged);
        // Add scraped venue to archive
        archiveVenue(venue);
      }
    } catch {
      setScrapeStatus(s => ({ ...s, [venue.id]: "error" }));
    }
  }, [allEvents, archiveVenue]);

  // Derived
  const categories = ["all", ...new Set(allEvents.map(e => e.category).filter(Boolean))];
  const filteredEvents = allEvents.filter(e => (filterType === "all" || e.venueType === filterType) && (filterCat === "all" || e.category === filterCat));
  const filteredVenues = venues.filter(v =>
    (filterType === "all" || v.type === filterType) && v.rating >= minRating &&
    (searchQuery.trim() === "" || v.name.toLowerCase().includes(searchQuery.toLowerCase()) || v.address.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  const venueTypes = ["all", ...new Set(venues.map(v => v.type).filter(Boolean))];
  const venueById = Object.fromEntries(venues.map(v => [v.id, v]));
  const selectedVenueEvents = selectedVenue ? (eventArchive[String(selectedVenue.id)]?.events || []) : [];
  const allArchiveTags = [...new Set(archive.flatMap(v => v.tags || []))].sort();
  const filteredArchive = archive.filter(v => {
    const matchText = !archiveFilter.trim() || v.name.toLowerCase().includes(archiveFilter.toLowerCase()) || v.address.toLowerCase().includes(archiveFilter.toLowerCase()) || (v.notes || "").toLowerCase().includes(archiveFilter.toLowerCase());
    const matchTag = archiveTagFilter === "all" || (v.tags || []).includes(archiveTagFilter);
    return matchText && matchTag;
  });

  const resetSearch = () => { setHasSearched(false); setSearchQuery(""); setFilterType("all"); setMinRating(0); setVenues([]); setSelectedVenue(null); setSearchError(""); setSearchStats(null); };

  const handleModalSave = (venue) => {
    if (modalMode === "add") setArchive(prev => [...prev, venue]);
    else if (modalMode === "edit") updateArchivedVenue(venue);
    else if (modalMode === "archive") archiveVenue(venue);
    setModalVenue(null); setModalMode(null);
  };

  return (
    <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", background: "#F8FAFC", minHeight: "100vh", color: "#0F172A" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #F1F5F9; } ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 4px; }
        .venue-card { border: 1px solid #E2E8F0; background: #FFFFFF; transition: all 0.2s; cursor: pointer; }
        .venue-card:hover { border-color: #3B82F6; background: #F8FAFF; transform: translateX(3px); }
        .venue-card.selected { border-color: #3B82F6; background: #EEF2FF; }
        .layer-btn { background: transparent; border: 1px solid #E2E8F0; color: #64748B; cursor: pointer; transition: all 0.2s; font-family: inherit; position: relative; }
        .layer-btn.active { background: #EEF2FF; border-color: #3B82F6; color: #1D4ED8; }
        .layer-btn:hover:not(.active) { border-color: #CBD5E1; color: #475569; }
        .scrape-btn { background: linear-gradient(135deg, #1E40AF, #1D4ED8); border: none; color: white; cursor: pointer; font-family: inherit; transition: all 0.2s; }
        .scrape-btn:hover:not(:disabled) { background: linear-gradient(135deg, #2563EB, #3B82F6); transform: translateY(-1px); }
        .scrape-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .event-row { border-bottom: 1px solid #E2E8F0; transition: background 0.15s; }
        .event-row:hover { background: #F8FAFC; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .pulse { animation: pulse 1.2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .tag { font-size: 10px; padding: 2px 7px; border-radius: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
        .filter-select { background: #FFFFFF; border: 1px solid #E2E8F0; color: #475569; font-family: inherit; font-size: 12px; padding: 5px 10px; border-radius: 3px; }
        .coord { color: #94A3B8; font-size: 10px; }
        .progress-bar { height: 2px; background: #E2E8F0; border-radius: 1px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #3B82F6, #60A5FA); transition: width 0.3s; }
        .source-badge { font-size: 9px; padding: 1px 5px; border-radius: 2px; letter-spacing: 0.05em; font-weight: 500; }
        .stats-bar { display: flex; gap: 10px; padding: 8px 12px; background: #F1F5F9; border: 1px solid #E2E8F0; border-radius: 3px; font-size: 10px; color: #64748B; align-items: center; flex-wrap: wrap; }
        .stats-bar .stat-num { color: #2563EB; font-weight: 600; }
        .icon-btn { background: none; border: 1px solid #E2E8F0; border-radius: 3px; cursor: pointer; padding: 4px 8px; font-size: 11px; font-family: inherit; color: #64748B; transition: all 0.15s; }
        .icon-btn:hover { border-color: #3B82F6; color: #2563EB; background: #EEF2FF; }
        .icon-btn.danger:hover { border-color: #EF4444; color: #EF4444; background: #FEF2F2; }
        .icon-btn.archive-btn { border-color: #10B981; color: #10B981; }
        .icon-btn.archive-btn:hover { background: #ECFDF5; }
        .icon-btn.archived { border-color: #CBD5E1; color: #94A3B8; cursor: default; }
      `}</style>

      {/* Modal */}
      {modalVenue !== null && (
        <VenueModal venue={modalVenue} onSave={handleModalSave}
          onClose={() => { setModalVenue(null); setModalMode(null); }}
          title={modalMode === "add" ? "Add New Venue" : modalMode === "archive" ? "Archive Venue" : "Edit Venue"} />
      )}

      {/* Header */}
      <div style={{ borderBottom: "1px solid #E2E8F0", padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
            PHILLY <span style={{ color: "#2563EB" }}>CULTURAL</span> RADAR
          </div>
          <div style={{ fontSize: 11, color: "#64748B", marginTop: 2, letterSpacing: "0.1em" }}>GENETIC EVENT PIPELINE · PHILADELPHIA PA</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {LAYER_LABELS.map((l, i) => (
            <button key={i} className={`layer-btn ${layer === i ? "active" : ""}`}
              onClick={() => setLayer(i)}
              style={{ padding: "7px 14px", fontSize: 11, borderRadius: 3, letterSpacing: "0.05em" }}>
              {l} · {LAYER_NAMES[i]}
              {i === 3 && archive.length > 0 && (
                <span style={{ position: "absolute", top: -5, right: -5, background: "#2563EB", color: "#fff", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 600, lineHeight: "14px" }}>
                  {archive.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════ Layer 1: Geo-Indexing ══════════ */}
      {layer === 0 && (
        <div style={{ padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700 }}>GEO-LOCATION INDEX</div>
            {hasSearched && <div style={{ fontSize: 11, color: "#64748B", padding: "3px 8px", border: "1px solid #E2E8F0", borderRadius: 2, background: "#FFF" }}>{filteredVenues.length} VENUES</div>}
            {archive.length > 0 && <div style={{ fontSize: 11, color: "#2563EB", padding: "3px 8px", border: "1px solid #BFDBFE", borderRadius: 2, background: "#EFF6FF" }}>{archive.length} in DB → used as seed</div>}
          </div>

          {!hasSearched ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 20 }}>
              <div style={{ fontSize: 28, fontFamily: "'Syne', sans-serif", fontWeight: 700, textAlign: "center" }}>SEARCH FOR VENUES</div>
              <div style={{ fontSize: 12, color: "#64748B", textAlign: "center", maxWidth: 460 }}>
                Enter an activity, genre, or venue type. Your archived venues ({archive.length}) are automatically included as search seeds.
              </div>
              <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 24, width: "100%", maxWidth: 500 }}>
                <input type="text" placeholder="Try: concert, pub, jazz, comedy, museum, dance…"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  onKeyPress={e => e.key === "Enter" && searchQuery.trim() && handleSearch(searchQuery)}
                  style={{ width: "100%", padding: "12px 16px", fontSize: 13, marginBottom: 12, background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3, color: "#0F172A", fontFamily: "inherit", boxSizing: "border-box" }}
                  autoFocus />
                <button onClick={() => handleSearch(searchQuery)} disabled={!searchQuery.trim() || searching} className="scrape-btn"
                  style={{ width: "100%", padding: "12px 16px", fontSize: 12, borderRadius: 3, opacity: (searchQuery.trim() && !searching) ? 1 : 0.5 }}>
                  {searching ? `⊙ ${searchProgress || "SEARCHING…"}` : "MULTI-STRATEGY SEARCH"}
                </button>
                <div style={{ marginTop: 14, fontSize: 10, color: "#94A3B8", lineHeight: 1.6 }}>
                  <div style={{ marginBottom: 4, color: "#64748B", fontWeight: 500, letterSpacing: "0.05em" }}>SEARCH PIPELINE:</div>
                  <div>① LLM → multiple query angles + venue types</div>
                  <div>② Parallel: textSearch × N + nearbySearch × type + your venue DB</div>
                  <div>③ Deduplicate → LLM semantic filter</div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {searchStats && (
                <div className="stats-bar" style={{ marginBottom: 16 }}>
                  <span>PIPELINE:</span>
                  <span>Text: <span className="stat-num">{searchStats.textResults}</span></span>
                  <span>Nearby: <span className="stat-num">{searchStats.nearbyResults}</span></span>
                  <span>Your DB: <span className="stat-num">{searchStats.archiveResults}</span></span>
                  <span>|</span>
                  <span>Deduped: <span className="stat-num">{searchStats.preFilter}</span></span>
                  <span>→ Final: <span className="stat-num">{searchStats.postFilter}</span></span>
                </div>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
                <input type="text" placeholder="Filter results…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  style={{ flex: 1, minWidth: 200, padding: "8px 12px", fontSize: 12, background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3, color: "#0F172A", fontFamily: "inherit" }} />
                <select value={filterType} onChange={e => setFilterType(e.target.value)} className="filter-select">
                  {venueTypes.map(t => <option key={t} value={t}>{t === "all" ? "All Types" : formatTypeLabel(t)}</option>)}
                </select>
                <select value={minRating} onChange={e => setMinRating(parseFloat(e.target.value))} className="filter-select">
                  <option value={0}>Any Rating</option><option value={4.0}>★ 4.0+</option><option value={4.5}>★ 4.5+</option>
                </select>
                <button onClick={resetSearch} style={{ padding: "7px 14px", fontSize: 11, background: "#EEF2FF", border: "1px solid #3B82F6", borderRadius: 3, color: "#1D4ED8", cursor: "pointer", fontFamily: "inherit" }}>← NEW SEARCH</button>
              </div>
              {searchError && <div style={{ marginBottom: 16, fontSize: 12, color: "#FCA5A5", border: "1px solid #7F1D1D", background: "#2A0F14", padding: "10px 12px", borderRadius: 4 }}>{searchError}</div>}

              {/* Map */}
              <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 20, marginBottom: 20, height: 420, overflow: "hidden" }}>
                <div style={{ fontSize: 10, color: "#64748B", marginBottom: 8, letterSpacing: "0.1em" }}>GEO MAP</div>
                {!googleMapsApiKey ? <div style={{ fontSize: 12, color: "#A0AEC0", paddingTop: 20 }}>Set VITE_GOOGLE_MAPS_API_KEY in .env</div>
                  : loadError ? <div style={{ fontSize: 12, color: "#EF4444", paddingTop: 20 }}>Google Maps failed to load</div>
                  : !isLoaded ? <div style={{ fontSize: 12, color: "#A0AEC0", paddingTop: 20 }}>Loading map…</div>
                  : (
                    <GoogleMap mapContainerStyle={{ width: "100%", height: "380px", borderRadius: 4 }}
                      center={{ lat: 39.9526, lng: -75.1652 }} zoom={12}
                      onLoad={map => setMapInstance(map)} onUnmount={() => setMapInstance(null)}
                      options={{ disableDefaultUI: true, zoomControl: true }}>
                      {venues.map(v => (
                        <MarkerF key={v.id} position={{ lat: v.lat, lng: v.lng }}
                          label={{ text: formatTypeLabel(v.type).slice(0, 1).toUpperCase(), color: "#0A0A0F", fontSize: "10px", fontWeight: "700" }}
                          onClick={() => setSelectedVenue(v)} />
                      ))}
                    </GoogleMap>
                  )}
              </div>

              {/* Venue cards */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {venues.map(v => (
                  <div key={v.id} className={`venue-card ${selectedVenue?.id === v.id ? "selected" : ""}`}
                    onClick={() => setSelectedVenue(v === selectedVenue ? null : v)}
                    style={{ padding: "12px 14px", borderRadius: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className="tag" style={{ background: v.color + "22", color: v.color, border: `1px solid ${v.color}44` }}>{formatTypeLabel(v.type)}</span>
                        <span style={{ fontSize: 10, color: "#4A5568" }}>★ {v.rating}</span>
                        {v.source === "archive" && <span className="source-badge" style={{ background: "#DBEAFE", color: "#1E40AF" }}>FROM DB</span>}
                      </div>
                      <button className={`icon-btn ${isArchived(v.name) ? "archived" : "archive-btn"}`}
                        onClick={e => { e.stopPropagation(); if (!isArchived(v.name)) { setModalVenue(v); setModalMode("archive"); } }}
                        title={isArchived(v.name) ? "Already in database" : "Archive to database"}>
                        {isArchived(v.name) ? "✓ DB" : "+ DB"}
                      </button>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#0F172A", marginBottom: 4 }}>{v.name}</div>
                    <div style={{ fontSize: 11, color: "#64748B" }}>{v.address}</div>
                    <div className="coord" style={{ marginTop: 5 }}>[{v.lat.toFixed(4)}, {v.lng.toFixed(4)}]</div>
                  </div>
                ))}
              </div>
              {selectedVenue && (
                <div style={{ marginTop: 12, background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>Events for {selectedVenue.name}</div>
                    {eventArchive[String(selectedVenue.id)]?.scrapedAt && (
                      <span style={{ fontSize: 10, color: "#94A3B8" }}>cached {new Date(eventArchive[String(selectedVenue.id)].scrapedAt).toLocaleString()}</span>
                    )}
                    <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => scrapeSingleVenue(selectedVenue)}>Scrape</button>
                  </div>
                  {selectedVenueEvents.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#64748B" }}>No cached events yet. Click “Scrape” to fetch.</div>
                  ) : (
                    <div style={{ maxHeight: 180, overflowY: "auto" }}>
                      {selectedVenueEvents.map((ev, i) => (
                        <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #E2E8F0" }}>
                          <div style={{ fontSize: 11, color: "#2563EB" }}>{ev.date} {ev.time}</div>
                          <div style={{ fontSize: 12, color: "#0F172A" }}>{ev.title}</div>
                          {ev.description && <div style={{ fontSize: 10, color: "#64748B" }}>{ev.description.slice(0, 80)}{ev.description.length > 80 ? "…" : ""}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {venues.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#4A5568", fontSize: 13 }}>No results found</div>}

              <div style={{ marginTop: 20, textAlign: "center" }}>
                <button className="scrape-btn" onClick={() => { setLayer(1); startScraping(); }}
                  disabled={venues.length === 0}
                  style={{ padding: "12px 32px", fontSize: 12, borderRadius: 3, letterSpacing: "0.08em" }}>
                  ▶ LAUNCH LAYER 2 · SCRAPING
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════ Layer 2: Scraping ══════════ */}
      {layer === 1 && (
        <div style={{ padding: 28 }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, marginBottom: 20 }}>EVENT SCRAPING PIPELINE</div>
          <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#64748B", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
              <span>VENUE</span><span style={{ display: "flex", gap: 40 }}><span>STATUS</span><span>EVENTS</span></span>
            </div>
            {venues.map(v => {
              const count = allEvents.filter(e => e.venueId === v.id).length;
              const status = scrapeStatus[v.id];
              return (
                <div key={v.id} style={{ padding: "14px 16px", borderBottom: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={`status-dot ${status === "scraping" ? "pulse" : ""}`} style={{ background: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#2D3748" }} />
                    <div>
                      <div style={{ fontSize: 12, color: "#0F172A" }}>{v.name}</div>
                      <div style={{ fontSize: 10, color: "#64748B" }}>{v.website || v.address}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
                    <span style={{ fontSize: 11, color: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#64748B", minWidth: 80, textAlign: "right" }}>
                      {status === "done" ? "COMPLETE" : status === "error" ? "FAILED" : status === "scraping" ? "SCRAPING…" : "QUEUED"}
                    </span>
                    <span style={{ fontSize: 13, color: count > 0 ? "#2563EB" : "#CBD5E1", fontWeight: 500, minWidth: 40, textAlign: "right" }}>{count > 0 ? count : "—"}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1 }}><div className="progress-bar"><div className="progress-fill" style={{ width: venues.length ? `${(Object.keys(scrapeStatus).length / venues.length) * 100}%` : "0%" }} /></div></div>
            <span style={{ fontSize: 11, color: "#64748B" }}>{Object.keys(scrapeStatus).length}/{venues.length}</span>
            {!scraping && allEvents.length > 0 && <button className="scrape-btn" onClick={() => setLayer(2)} style={{ padding: "8px 20px", fontSize: 11, borderRadius: 3 }}>Layer 3 →</button>}
          </div>
          {allEvents.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, color: "#64748B", marginBottom: 10, letterSpacing: "0.1em" }}>LIVE FEED · {allEvents.length} events</div>
              <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, maxHeight: 200, overflowY: "auto" }}>
                {allEvents.slice(-10).reverse().map((e, i) => (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #E2E8F0", fontSize: 11, display: "flex", gap: 10 }}>
                    <span style={{ color: "#64748B" }}>[{formatTypeLabel(e.venueType).slice(0, 3).toUpperCase()}]</span>
                    <span style={{ color: "#2563EB" }}>{e.date}</span>
                    <span style={{ color: "#0F172A" }}>{e.title}</span>
                    <span style={{ color: "#64748B", marginLeft: "auto" }}>{e.venue?.split(" ").slice(0, 2).join(" ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════ Layer 3: Event Data ══════════ */}
      {layer === 2 && (
        <div style={{ padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700 }}>EVENT DATA</div>
            <div style={{ fontSize: 11, color: "#64748B", padding: "3px 8px", border: "1px solid #E2E8F0", borderRadius: 2, background: "#FFF" }}>{filteredEvents.length} RECORDS</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <select className="filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
                {venueTypes.map(t => <option key={t} value={t}>{t === "all" ? "All Types" : formatTypeLabel(t)}</option>)}
              </select>
              <select className="filter-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
                {categories.map(c => <option key={c} value={c}>{c === "all" ? "All Categories" : c}</option>)}
              </select>
            </div>
          </div>
          {allEvents.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#64748B" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⚙</div>
              <div style={{ fontSize: 13 }}>No data scraped yet</div>
              <button className="scrape-btn" onClick={() => setLayer(0)} style={{ padding: "10px 24px", fontSize: 11, borderRadius: 3, marginTop: 16 }}>← Layer 1</button>
            </div>
          ) : (
            <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "70px 100px 90px 90px 60px 1fr 120px 80px", gap: 0, padding: "10px 16px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#64748B", letterSpacing: "0.1em" }}>
                <span>TYPE</span><span>DATE</span><span>TIME</span><span>CAT</span><span>FREE</span><span>EVENT</span><span>SPACE·TIME</span><span>VENUE</span>
              </div>
              <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
                {filteredEvents.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: "#64748B", fontSize: 12 }}>No matching records</div>
                : filteredEvents.map((e, i) => (
                  <div key={i} className="event-row" style={{ display: "grid", gridTemplateColumns: "70px 100px 90px 90px 60px 1fr 120px 80px", gap: 0, padding: "12px 16px", alignItems: "start" }}>
                    <span className="tag" style={{ background: hashColor(e.venueType) + "22", color: hashColor(e.venueType), border: `1px solid ${hashColor(e.venueType)}44`, alignSelf: "center" }}>{formatTypeLabel(e.venueType).slice(0, 3).toUpperCase()}</span>
                    <span style={{ fontSize: 11, color: "#64748B", alignSelf: "center" }}>{e.date}</span>
                    <span style={{ fontSize: 11, color: "#64748B", alignSelf: "center" }}>{e.time}</span>
                    <span style={{ fontSize: 10, color: "#2563EB", alignSelf: "center" }}>{e.category}</span>
                    <span style={{ fontSize: 11, color: e.free ? "#10B981" : "#EF4444", alignSelf: "center" }}>{e.free ? "FREE" : "PAID"}</span>
                    <div style={{ alignSelf: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{e.title}</div>
                      {e.description && <div style={{ fontSize: 10, color: "#64748B" }}>{e.description.slice(0, 80)}{e.description.length > 80 ? "…" : ""}</div>}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748B", alignSelf: "center" }}>
                      <div>{e.date} {e.time}</div>
                      {venueById[e.venueId]?.lat && venueById[e.venueId]?.lng && (
                        <div style={{ color: "#94A3B8" }}>[{venueById[e.venueId].lat.toFixed(4)}, {venueById[e.venueId].lng.toFixed(4)}]</div>
                      )}
                    </div>
                    <span style={{ fontSize: 10, color: "#64748B", alignSelf: "center", textAlign: "right", wordBreak: "break-word" }}>{e.venue?.split(" ").slice(0, 2).join(" ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {allEvents.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 16 }}>
              {[
                { label: "Total Events", value: allEvents.length, color: "#60A5FA" },
                { label: "Free Events", value: allEvents.filter(e => e.free).length, color: "#10B981" },
                { label: "From Your DB", value: allEvents.filter(e => venues.find(v => v.id === e.venueId)?.source === "archive").length, color: "#8B5CF6" },
                { label: "Unique Venues", value: new Set(allEvents.map(e => e.venueId)).size, color: "#F59E0B" },
              ].map((s, i) => (
                <div key={i} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: "14px 16px" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: "'Syne', sans-serif" }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════ Layer 4: Venue Database ══════════ */}
      {layer === 3 && (
        <div style={{ padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700 }}>VENUE DATABASE</div>
            <div style={{ fontSize: 11, color: "#64748B", padding: "3px 8px", border: "1px solid #E2E8F0", borderRadius: 2, background: "#FFF" }}>{archive.length} ENTRIES</div>
            <div style={{ fontSize: 10, color: "#94A3B8" }}>Persistent · Used as search seed in L1</div>
            <button className="scrape-btn" onClick={() => { setModalVenue({}); setModalMode("add"); }}
              style={{ marginLeft: "auto", padding: "8px 16px", fontSize: 11, borderRadius: 3 }}>+ ADD VENUE</button>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <input type="text" placeholder="Search database…" value={archiveFilter} onChange={e => setArchiveFilter(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: "8px 12px", fontSize: 12, background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3, color: "#0F172A", fontFamily: "inherit" }} />
            <select className="filter-select" value={archiveTagFilter} onChange={e => setArchiveTagFilter(e.target.value)}>
              <option value="all">All Tags</option>
              {allArchiveTags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {archive.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#64748B" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📂</div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Your venue database is empty</div>
              <div style={{ fontSize: 12, maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
                Search for venues in Layer 1 and click "+ DB" to archive them. Or add manually.
                Archived venues become search seeds for future queries.
              </div>
              <button className="scrape-btn" onClick={() => { setModalVenue({}); setModalMode("add"); }}
                style={{ padding: "10px 24px", fontSize: 11, borderRadius: 3, marginTop: 20 }}>+ ADD FIRST VENUE</button>
            </div>
          ) : (
            <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(140px,2fr) minmax(120px,2fr) 80px minmax(100px,2fr) 80px 64px", padding: "10px 16px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#64748B", letterSpacing: "0.1em", gap: 12 }}>
                <span>NAME</span><span>ADDRESS</span><span>TYPE</span><span>TAGS</span><span>INFO</span><span></span>
              </div>
              <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
                {filteredArchive.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: "#64748B", fontSize: 12 }}>No matches</div>
                : filteredArchive.map(v => (
                  <div key={v.id} style={{ display: "grid", gridTemplateColumns: "minmax(140px,2fr) minmax(120px,2fr) 80px minmax(100px,2fr) 80px 64px", padding: "12px 16px", borderBottom: "1px solid #E2E8F0", gap: 12, alignItems: "center", fontSize: 12 }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{v.name}</div>
                      {v.notes && <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 2 }}>{v.notes.slice(0, 40)}{v.notes.length > 40 ? "…" : ""}</div>}
                      <div className="coord" style={{ marginTop: 2 }}>[{(v.lat || 0).toFixed(4)}, {(v.lng || 0).toFixed(4)}]</div>
                    </div>
                    <div style={{ fontSize: 11, color: "#64748B" }}>{v.address}</div>
                    <span className="tag" style={{ background: hashColor(v.type) + "22", color: hashColor(v.type), border: `1px solid ${hashColor(v.type)}44`, justifySelf: "start" }}>{formatTypeLabel(v.type).slice(0, 6)}</span>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {(v.tags || []).map((tag, i) => (
                        <span key={i} style={{ fontSize: 9, padding: "1px 4px", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 2, color: "#475569" }}>{tag}</span>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: "#4A5568" }}>★ {v.rating || "—"}</div>
                      {v.website && <a href={v.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#2563EB", textDecoration: "none" }}>site ↗</a>}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="icon-btn" title="View Events" onClick={() => setSelectedArchiveVenue(selectedArchiveVenue?.id === v.id ? null : v)} style={{ background: selectedArchiveVenue?.id === v.id ? "#EEF2FF" : "transparent" }}>🎭</button>
                      <button className="icon-btn" onClick={() => { setModalVenue(v); setModalMode("edit"); }} title="Edit">✎</button>
                      <button className="icon-btn danger" onClick={() => { if (confirm(`Delete "${v.name}"?`)) deleteArchivedVenue(v.id); }} title="Delete">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedArchiveVenue && (
            <div style={{ marginTop: 16, background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Events · {selectedArchiveVenue.name}</div>
                {eventArchive[String(selectedArchiveVenue.id)]?.scrapedAt && (
                  <span style={{ fontSize: 10, color: "#94A3B8" }}>cached {new Date(eventArchive[String(selectedArchiveVenue.id)].scrapedAt).toLocaleString()}</span>
                )}
                <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => scrapeSingleVenue(selectedArchiveVenue)} title="Scrape Events">↻</button>
                <button className="icon-btn" onClick={() => setSelectedArchiveVenue(null)} title="Close">✕</button>
              </div>
              {(eventArchive[String(selectedArchiveVenue.id)]?.events || []).length === 0 ? (
                <div style={{ fontSize: 12, color: "#64748B", padding: 20, textAlign: "center" }}>No events cached. Click ↻ to fetch.</div>
              ) : (
                <div style={{ maxHeight: 300, overflowY: "auto" }}>
                  {(eventArchive[String(selectedArchiveVenue.id)]?.events || []).map((ev, i) => (
                    <div key={i} style={{ padding: "10px 0", borderBottom: "1px solid #E2E8F0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ fontWeight: 500, color: "#0F172A" }}>{ev.title}</div>
                        <div style={{ fontSize: 11, color: "#2563EB" }}>{ev.date} {ev.time}</div>
                      </div>
                      {ev.description && <div style={{ fontSize: 11, color: "#64748B" }}>{ev.description}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {allArchiveTags.length > 0 && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: "#64748B", marginBottom: 8, letterSpacing: "0.1em" }}>TAG INDEX</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {allArchiveTags.map(tag => {
                  const count = archive.filter(v => (v.tags || []).includes(tag)).length;
                  const isActive = archiveTagFilter === tag;
                  return (
                    <button key={tag} onClick={() => setArchiveTagFilter(isActive ? "all" : tag)}
                      style={{ fontSize: 10, padding: "3px 8px", borderRadius: 2, cursor: "pointer", fontFamily: "inherit",
                        background: isActive ? "#EEF2FF" : "#F8FAFC", border: `1px solid ${isActive ? "#3B82F6" : "#E2E8F0"}`, color: isActive ? "#1D4ED8" : "#64748B" }}>
                      {tag} ({count})
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
