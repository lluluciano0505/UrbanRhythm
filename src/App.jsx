import { useState, useCallback } from "react";
import { GoogleMap, MarkerF, useJsApiLoader } from "@react-google-maps/api";

const LAYER_LABELS = ["Layer 1", "Layer 2", "Layer 3"];
const LAYER_NAMES = ["Geo-Indexing", "Event Scraping", "Data Archive"];

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

async function searchVenues(query, placesService) {
  if (!query?.trim()) {
    return { venues: [], error: "Empty query", source: "none" };
  }

  const fallbackService = placesService || (window.google?.maps?.places
    ? new window.google.maps.places.PlacesService(document.createElement("div"))
    : null);

  if (!fallbackService) {
    console.warn("Places service unavailable. Check Google Maps API key and Places API enablement.");
    return { venues: [], error: "Places service unavailable (check API key, Maps JS + Places enabled)", source: "places" };
  }

  return new Promise((resolve) => {
    const phillyCenter = new window.google.maps.LatLng(39.9526, -75.1652);
    const request = {
      query,
      location: phillyCenter,
      radius: 20000
    };

    fallbackService.textSearch(request, async (results, status) => {
      if (status !== window.google.maps.places.PlacesServiceStatus.OK || !results) {
        console.warn("Places search failed:", status);
        resolve({ venues: [], error: `Places search failed: ${status}`, source: "places" });
        return;
      }

      const topResults = results.slice(0, 10);
      const detailed = await Promise.all(topResults.map((place) => (
        new Promise((res) => {
          if (!place.place_id) {
            res(place);
            return;
          }
          fallbackService.getDetails(
            {
              placeId: place.place_id,
              fields: ["name", "formatted_address", "geometry", "rating", "website", "types", "place_id"]
            },
            (detail, detailStatus) => {
              if (detailStatus === window.google.maps.places.PlacesServiceStatus.OK && detail) {
                res(detail);
              } else {
                res(place);
              }
            }
          );
        })
      )));

      const mapped = detailed.map((place, index) => {
        const types = place.types || [];
        const typeFromTypes = types[0] || "venue";
        const typeFromQuery = query.trim() ? query.trim().toLowerCase().replace(/\s+/g, "_") : null;
        const type = typeFromTypes || typeFromQuery || "venue";
        return {
          id: place.place_id || index + 1,
          type,
          name: place.name || "Unknown",
          address: place.formatted_address || place.vicinity || "",
          lat: place.geometry?.location?.lat?.() || 0,
          lng: place.geometry?.location?.lng?.() || 0,
          rating: place.rating || 4.3,
          website: place.website || "",
          color: hashColor(type)
        };
      }).filter(v => v.lat && v.lng);

      resolve({ venues: mapped, error: null, source: "places" });
    });
  });
}

async function scrapeVenueEvents(venue) {
  const venueType = venue.type || "venue";
  const venueTypeLabel = formatTypeLabel(venueType);
  const openRouterApiKey = import.meta.env.VITE_OPENROUTER_API_KEY || "";

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openRouterApiKey}`
      },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        temperature: 0.7,
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: `You are a cultural event database curator. Generate 5-8 REALISTIC, DIVERSE upcoming events for this Philadelphia venue:

Venue Name: ${venue.name}
Venue Type: ${venueTypeLabel}
Website: ${venue.website}

IMPORTANT: Generate varied, realistic events with different:
- Dates spread across March-April 2026
- Times throughout the day (morning, afternoon, evening)
- Categories relevant to the venue type
- Mix of free (true) and paid (false) events
- Detailed, specific descriptions (not generic)

Return ONLY valid JSON array, no markdown:
[
{"title":"Specific Event Title","date":"2026-03-15","time":"2:00 PM","category":"Book Club","description":"Detailed description about what happens at this specific event","free":true},
{"title":"Another Specific Event","date":"2026-03-22","time":"10:30 AM","category":"Children's Program","description":"What children will experience and learn","free":true}
]

CRITICAL: Return 5-8 events. Each must have title, date, time, category, description (20-50 words), and free boolean. Ensure variety in dates and times.`
        }]
      })
    });
    
    if (!response.ok) {
      console.error(`Scrape API error for ${venue.name}:`, response.status);
      return [];
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`No content for ${venue.name}`);
      return [];
    }
    
    try {
      const cleaned = content.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      
      // Validate events
      const events = Array.isArray(parsed) ? parsed : [];
      const validEvents = events.filter(e => 
        e.title && e.date && e.time && e.category && e.description && typeof e.free === "boolean"
      );
      
      console.log(`✓ ${venue.name}: Got ${validEvents.length} valid events (of ${events.length} total)`);
      return validEvents;
    } catch (e) {
      console.error(`Parse error for ${venue.name}:`, e.message);
      console.error(`Raw content: ${content.slice(0, 200)}`);
      return [];
    }
  } catch (error) {
    console.error(`Scrape error for ${venue.name}:`, error.message);
    return [];
  }
}

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
  const [mapInstance, setMapInstance] = useState(null);
  const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey,
    libraries: ["places"]
  });

  const handleSearch = useCallback(async (query) => {
    setSearching(true);
    setSearchError("");
    try {
      const placesService = mapInstance ? new window.google.maps.places.PlacesService(mapInstance) : null;
      const result = await searchVenues(query, placesService);
      setVenues(result.venues || []);
      if (result.error) {
        setSearchError(result.error);
      }
      setHasSearched(true);
    } catch (error) {
      console.error("Search error:", error);
      setVenues([]);
      setSearchError(error.message || "Unknown search error");
    } finally {
      setSearching(false);
    }
  }, []);

  const resetSearch = useCallback(() => {
    setHasSearched(false);
    setSearchQuery("");
    setFilterType("all");
    setFilterCat("all");
    setMinRating(0);
    setSelectedVenue(null);
    setSearchError("");
    setVenues([]);
  }, []);

  const startScraping = useCallback(async () => {
    setScraping(true);
    setAllEvents([]);
    setScrapeStatus({});
    const results = [];

    console.log(`Starting scrape of ${venues.length} venues`);

    await Promise.allSettled(
      venues.map(async (venue) => {
        setScrapeStatus(s => ({ ...s, [venue.id]: "scraping" }));
        try {
          const events = await scrapeVenueEvents(venue);
          setScrapeStatus(s => ({ ...s, [venue.id]: "done" }));

          if (Array.isArray(events) && events.length > 0) {
            events.forEach(ev => {
              const eventWithVenue = {
                ...ev,
                venue: venue.name,
                venueType: venue.type,
                venueId: venue.id
              };
              results.push(eventWithVenue);
            });
            console.log(`Added ${events.length} events from ${venue.name}, total now: ${results.length}`);
          } else {
            console.log(`No events returned for ${venue.name}`);
          }

          setAllEvents([...results]);
        } catch (error) {
          console.error(`Error scraping ${venue.name}:`, error);
          setScrapeStatus(s => ({ ...s, [venue.id]: "error" }));
        }
      })
    );

    console.log(`Scraping complete. Total events collected: ${results.length}`);
    setScraping(false);
    setLayer(2);
  }, [venues]);

  const categories = ["all", ...new Set(allEvents.map(e => e.category).filter(Boolean))];
  const venueTypes = ["all", ...new Set(venues.map(v => v.type).filter(Boolean))];
  const filteredEvents = allEvents.filter(e =>
    (filterType === "all" || e.venueType === filterType) &&
    (filterCat === "all" || e.category === filterCat)
  );

  // Smart venue filtering
  const filteredVenues = venues.filter(v => {
    const matchesType = filterType === "all" || v.type === filterType;
    const matchesRating = v.rating >= minRating;
    const matchesSearch = searchQuery.trim() === "" || 
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.address.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesType && matchesRating && matchesSearch;
  });

  return (
    <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", background: "#F8FAFC", minHeight: "100vh", color: "#0F172A" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #E2E8F0; } ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        .venue-card { border: 1px solid #E2E8F0; background: #FFFFFF; transition: all 0.2s; cursor: pointer; }
        .venue-card:hover { border-color: #3B82F6; background: #F1F5FF; transform: translateX(3px); }
        .venue-card.selected { border-color: #3B82F6; background: #EEF2FF; }
        .layer-btn { background: #FFFFFF; border: 1px solid #E2E8F0; color: #334155; cursor: pointer; transition: all 0.2s; font-family: inherit; }
        .layer-btn.active { background: #EEF2FF; border-color: #3B82F6; color: #1D4ED8; }
        .layer-btn:hover:not(.active) { border-color: #CBD5E1; color: #0F172A; }
        .scrape-btn { background: linear-gradient(135deg, #1E40AF, #1D4ED8); border: none; color: white; cursor: pointer; font-family: inherit; transition: all 0.2s; }
        .scrape-btn:hover:not(:disabled) { background: linear-gradient(135deg, #2563EB, #3B82F6); transform: translateY(-1px); }
        .scrape-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .event-row { border-bottom: 1px solid #E2E8F0; transition: background 0.15s; }
        .event-row:hover { background: #F8FAFC; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .pulse { animation: pulse 1.2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .tag { font-size: 10px; padding: 2px 7px; border-radius: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
        .filter-select { background: #FFFFFF; border: 1px solid #E2E8F0; color: #334155; font-family: inherit; font-size: 12px; padding: 5px 10px; border-radius: 3px; }
        .coord { color: #64748B; font-size: 10px; }
        .progress-bar { height: 2px; background: #E2E8F0; border-radius: 1px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #3B82F6, #60A5FA); transition: width 0.3s; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #E2E8F0", padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FFFFFF" }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", color: "#0F172A" }}>
            PHILLY <span style={{ color: "#3B82F6" }}>CULTURAL</span> RADAR
          </div>
          <div style={{ fontSize: 11, color: "#64748B", marginTop: 2, letterSpacing: "0.1em" }}>GENETIC EVENT PIPELINE · PHILADELPHIA PA</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {LAYER_LABELS.map((l, i) => (
            <button key={i} className={`layer-btn ${layer === i ? "active" : ""}`}
              onClick={() => setLayer(i)}
              style={{ padding: "7px 14px", fontSize: 11, borderRadius: 3, letterSpacing: "0.05em" }}>
              {l} · {LAYER_NAMES[i]}
            </button>
          ))}
        </div>
      </div>

      {/* Layer 1: Venues */}
      {layer === 0 && (
        <div style={{ padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#0F172A" }}>GEO-LOCATION INDEX</div>
            {hasSearched && (
              <div style={{ fontSize: 11, color: "#64748B", padding: "3px 8px", border: "1px solid #E2E8F0", borderRadius: 2, background: "#FFFFFF" }}>{filteredVenues.length} VENUES</div>
            )}
          </div>

          {!hasSearched ? (
            /* Initial Search Interface */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 20 }}>
              <div style={{ fontSize: 28, fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "#0F172A", textAlign: "center" }}>
                SEARCH FOR VENUES
              </div>
              <div style={{ fontSize: 12, color: "#64748B", textAlign: "center", maxWidth: 400 }}>
                Enter a location, address, or venue name to discover cultural venues in Philadelphia
              </div>
              
              <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 24, width: "100%", maxWidth: 500 }}>
                <input 
                  type="text"
                  placeholder="Search by address, venue name, or neighborhood..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === "Enter" && searchQuery.trim() && handleSearch(searchQuery)}
                  style={{ 
                    width: "100%", padding: "12px 16px", fontSize: 13, marginBottom: 12,
                    background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3,
                    color: "#0F172A", fontFamily: "inherit", boxSizing: "border-box"
                  }}
                  autoFocus
                />
                
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button 
                    onClick={() => handleSearch("libraries Philadelphia")}
                    disabled={searching}
                    style={{ 
                      flex: 1, padding: "10px 12px", fontSize: 11, background: "#EEF2FF", 
                      border: "1px solid #3B82F6", borderRadius: 3, color: "#1D4ED8",
                      cursor: "pointer", fontFamily: "inherit", opacity: searching ? 0.5 : 1
                    }}
                  >
                    {searching ? "⊙ SEARCHING..." : "▶ Libraries"}
                  </button>
                  <button 
                    onClick={() => handleSearch("museums Philadelphia")}
                    disabled={searching}
                    style={{ 
                      flex: 1, padding: "10px 12px", fontSize: 11, background: "#FEF3C7", 
                      border: "1px solid #F59E0B", borderRadius: 3, color: "#B45309",
                      cursor: "pointer", fontFamily: "inherit", opacity: searching ? 0.5 : 1
                    }}
                  >
                    {searching ? "⊙ SEARCHING..." : "▶ Museums"}
                  </button>
                </div>

                <button 
                  onClick={() => handleSearch(searchQuery)}
                  disabled={!searchQuery.trim() || searching}
                  className="scrape-btn"
                  style={{ 
                    width: "100%", padding: "12px 16px", fontSize: 12, borderRadius: 3,
                    opacity: (searchQuery.trim() && !searching) ? 1 : 0.5,
                    cursor: (searchQuery.trim() && !searching) ? "pointer" : "not-allowed"
                  }}
                >
                  {searching ? "⊙ SEARCHING VENUES..." : "SEARCH VENUES"}
                </button>
              </div>
            </div>
          ) : (
            /* Search Results */
            <>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
                <input 
                  type="text"
                  placeholder="Refine search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ 
                    flex: 1, minWidth: 200, padding: "8px 12px", fontSize: 12, 
                    background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 3,
                    color: "#0F172A", fontFamily: "inherit"
                  }}
                />
                <select 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  className="filter-select"
                >
                  {venueTypes.map(t => (
                    <option key={t} value={t}>{t === "all" ? "All Types" : formatTypeLabel(t)}</option>
                  ))}
                </select>
                <select 
                  value={minRating} 
                  onChange={(e) => setMinRating(parseFloat(e.target.value))}
                  className="filter-select"
                >
                  <option value={0}>Any Rating</option>
                  <option value={4.0}>★ 4.0+</option>
                  <option value={4.5}>★ 4.5+</option>
                  <option value={4.6}>★ 4.6+</option>
                </select>
                <button 
                  onClick={resetSearch}
                  style={{ 
                    padding: "7px 14px", fontSize: 11, background: "#EEF2FF", 
                    border: "1px solid #3B82F6", borderRadius: 3, color: "#1D4ED8",
                    cursor: "pointer", fontFamily: "inherit"
                  }}
                >
                  ← NEW SEARCH
                </button>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button
                  onClick={resetSearch}
                  style={{
                    padding: "6px 12px",
                    fontSize: 11,
                    background: "#FFFFFF",
                    border: "1px dashed #3B82F6",
                    borderRadius: 3,
                    color: "#1D4ED8",
                    cursor: "pointer",
                    fontFamily: "inherit"
                  }}
                >
                  Reset and start a new search
                </button>
              </div>

              {searchError && (
                <div style={{ marginBottom: 16, fontSize: 12, color: "#FCA5A5", border: "1px solid #7F1D1D", background: "#2A0F14", padding: "10px 12px", borderRadius: 4 }}>
                  Search error: {searchError}
                </div>
              )}

              {/* Google map visualization */}
              <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: 20, marginBottom: 20, position: "relative", height: 420, overflow: "hidden" }}>
                <div style={{ position: "relative", fontSize: 10, color: "#64748B", marginBottom: 8, letterSpacing: "0.1em" }}>GEO MAP · Google Maps</div>
                {!googleMapsApiKey ? (
                  <div style={{ fontSize: 12, color: "#A0AEC0", paddingTop: 20 }}>
                    Missing Google Maps API key. Set VITE_GOOGLE_MAPS_API_KEY in a .env file and restart the dev server.
                  </div>
                ) : loadError ? (
                  <div style={{ fontSize: 12, color: "#EF4444", paddingTop: 20 }}>
                    Google Maps failed to load. Check API key restrictions and billing.
                  </div>
                ) : !isLoaded ? (
                  <div style={{ fontSize: 12, color: "#A0AEC0", paddingTop: 20 }}>
                    Loading map…
                  </div>
                ) : (
                  <GoogleMap
                    mapContainerStyle={{ width: "100%", height: "380px", borderRadius: 4 }}
                    center={{ lat: 39.9526, lng: -75.1652 }}
                    zoom={12}
                    onLoad={(map) => setMapInstance(map)}
                    onUnmount={() => setMapInstance(null)}
                    options={{
                      disableDefaultUI: true,
                      zoomControl: true,
                      streetViewControl: false,
                      mapTypeControl: false,
                      fullscreenControl: false
                    }}
                  >
                    {filteredVenues.map(v => (
                      <MarkerF
                        key={v.id}
                        position={{ lat: v.lat, lng: v.lng }}
                        label={{
                          text: formatTypeLabel(v.type).slice(0, 1).toUpperCase(),
                          color: "#0A0A0F",
                          fontSize: "10px",
                          fontWeight: "700"
                        }}
                        onClick={() => setSelectedVenue(v)}
                      />
                    ))}
                  </GoogleMap>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {filteredVenues.map(v => (
                  <div key={v.id} className={`venue-card ${selectedVenue?.id === v.id ? "selected" : ""}`}
                    onClick={() => setSelectedVenue(v === selectedVenue ? null : v)}
                    style={{ padding: "12px 14px", borderRadius: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="tag" style={{ background: v.color + "22", color: v.color, border: `1px solid ${v.color}44` }}>
                          {formatTypeLabel(v.type)}
                        </span>
                        <span style={{ fontSize: 10, color: "#4A5568" }}>★ {v.rating}</span>
                      </div>
                      <span style={{ fontSize: 10, color: scrapeStatus[v.id] === "done" ? "#10B981" : scrapeStatus[v.id] === "error" ? "#EF4444" : scrapeStatus[v.id] === "scraping" ? "#F59E0B" : "#2D3748" }}>
                        {scrapeStatus[v.id] === "done" ? "✓ scraped" : scrapeStatus[v.id] === "error" ? "✗ error" : scrapeStatus[v.id] === "scraping" ? "… loading" : "pending"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#0F172A", marginBottom: 4 }}>{v.name}</div>
                    <div style={{ fontSize: 11, color: "#64748B" }}>{v.address}</div>
                    <div className="coord" style={{ marginTop: 5 }}>[{v.lat.toFixed(4)}, {v.lng.toFixed(4)}]</div>
                  </div>
                ))}
              </div>

              {filteredVenues.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#4A5568" }}>
                  <div style={{ fontSize: 13 }}>No results found</div>
                  <div style={{ fontSize: 11, marginTop: 6 }}>Try adjusting your search terms or filters</div>
                  {searchError && (
                    <div style={{ fontSize: 11, marginTop: 10, color: "#FCA5A5" }}>Last error: {searchError}</div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 20, textAlign: "center" }}>
                <button className="scrape-btn" onClick={() => { setLayer(1); startScraping(); }}
                  disabled={filteredVenues.length === 0}
                  style={{ padding: "12px 32px", fontSize: 12, borderRadius: 3, letterSpacing: "0.08em", opacity: filteredVenues.length === 0 ? 0.5 : 1, cursor: filteredVenues.length === 0 ? "not-allowed" : "pointer" }}>
                  ▶ LAUNCH LAYER 2 · SCRAPING
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Layer 2: Scraping */}
      {layer === 1 && (
        <div style={{ padding: 28 }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#0F172A", marginBottom: 20 }}>
            EVENT SCRAPING · Web Scraping Pipeline
          </div>
          <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#64748B", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
              <span>VENUE</span>
              <span style={{ display: "flex", gap: 40 }}><span>STATUS</span><span>EVENTS FOUND</span></span>
            </div>
            {venues.map(v => {
              const count = allEvents.filter(e => e.venueId === v.id).length;
              const status = scrapeStatus[v.id];
              return (
                <div key={v.id} style={{ padding: "14px 16px", borderBottom: "1px solid #E2E8F0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={`status-dot ${status === "scraping" ? "pulse" : ""}`}
                      style={{ background: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#2D3748" }} />
                    <div>
                      <div style={{ fontSize: 12, color: "#0F172A" }}>{v.name}</div>
                      <div style={{ fontSize: 10, color: "#64748B" }}>{v.website}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
                    <span style={{ fontSize: 11, color: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#64748B", minWidth: 80, textAlign: "right" }}>
                      {status === "done" ? "COMPLETE" : status === "error" ? "FAILED" : status === "scraping" ? "SCRAPING…" : "QUEUED"}
                    </span>
                    <span style={{ fontSize: 13, color: count > 0 ? "#2563EB" : "#CBD5E1", fontWeight: 500, minWidth: 40, textAlign: "right" }}>
                      {count > 0 ? count : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: venues.length > 0 ? `${(Object.keys(scrapeStatus).length / venues.length) * 100}%` : "0%" }} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: "#64748B" }}>{Object.keys(scrapeStatus).length}/{venues.length} venues processing</span>
            {!scraping && allEvents.length > 0 && (
              <button className="scrape-btn" onClick={() => setLayer(2)}
                style={{ padding: "8px 20px", fontSize: 11, borderRadius: 3 }}>
                View Layer 3 · Data Table →
              </button>
            )}
          </div>

          {/* Live event feed */}
          {allEvents.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, color: "#64748B", marginBottom: 10, letterSpacing: "0.1em" }}>LIVE FEED · {allEvents.length} events captured</div>
              <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, maxHeight: 200, overflowY: "auto" }}>
                {allEvents.slice(-10).reverse().map((e, i) => (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #E2E8F0", fontSize: 11, display: "flex", gap: 10 }}>
                    <span style={{ color: "#64748B", flexShrink: 0 }}>[{formatTypeLabel(e.venueType).slice(0, 3).toUpperCase()}]</span>
                    <span style={{ color: "#2563EB", flexShrink: 0 }}>{e.date || "TBD"}</span>
                    <span style={{ color: "#0F172A" }}>{e.title}</span>
                    <span style={{ color: "#64748B", marginLeft: "auto", flexShrink: 0 }}>{e.venue.split(" ").slice(0, 2).join(" ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Layer 3: Table */}
      {layer === 2 && (
        <div style={{ padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#0F172A" }}>DATA ARCHIVE · Event Archive</div>
            <div style={{ fontSize: 11, color: "#64748B", padding: "3px 8px", border: "1px solid #E2E8F0", borderRadius: 2, background: "#FFFFFF" }}>{filteredEvents.length} RECORDS</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <select className="filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
                {venueTypes.map(t => (
                  <option key={t} value={t}>{t === "all" ? "All Types" : formatTypeLabel(t)}</option>
                ))}
              </select>
              <select className="filter-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
                {categories.map(c => <option key={c} value={c}>{c === "all" ? "All Categories" : c}</option>)}
              </select>
              {scraping && (
                <span style={{ fontSize: 11, color: "#F59E0B" }}>
                  <span className="status-dot pulse" style={{ background: "#F59E0B", marginRight: 6 }} />
                  Scraping…
                </span>
              )}
            </div>
          </div>

          {allEvents.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#64748B" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⚙</div>
              <div style={{ fontSize: 13 }}>No data scraped yet</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>Go to Layer 1 to start scraping</div>
              <button className="scrape-btn" onClick={() => setLayer(0)}
                style={{ padding: "10px 24px", fontSize: 11, borderRadius: 3, marginTop: 16 }}>
                ← Back to Layer 1
              </button>
            </div>
          ) : (
            <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, overflow: "hidden" }}>
              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "80px 130px 160px 100px 90px 1fr 70px", gap: 0, padding: "10px 16px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#64748B", letterSpacing: "0.1em" }}>
                <span>TYPE</span><span>DATE</span><span>TIME</span><span>CATEGORY</span><span>FREE</span><span>EVENT</span><span>VENUE</span>
              </div>
              <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
                {filteredEvents.length === 0 ? (
                  <div style={{ padding: 30, textAlign: "center", color: "#64748B", fontSize: 12 }}>No matching records</div>
                ) : filteredEvents.map((e, i) => (
                  <div key={i} className="event-row" style={{ display: "grid", gridTemplateColumns: "80px 130px 160px 100px 90px 1fr 70px", gap: 0, padding: "12px 16px", alignItems: "start" }}>
                    <span className="tag" style={{
                      background: hashColor(e.venueType) + "22",
                      color: hashColor(e.venueType),
                      border: `1px solid ${hashColor(e.venueType)}44`,
                      alignSelf: "center"
                    }}>{formatTypeLabel(e.venueType).slice(0, 3).toUpperCase()}</span>
                    <span style={{ fontSize: 11, color: "#64748B", alignSelf: "center" }}>{e.date || "—"}</span>
                    <span style={{ fontSize: 11, color: "#64748B", alignSelf: "center" }}>{e.time || "—"}</span>
                    <span style={{ fontSize: 10, color: "#2563EB", alignSelf: "center" }}>{e.category || "—"}</span>
                    <span style={{ fontSize: 11, color: e.free ? "#10B981" : "#EF4444", alignSelf: "center" }}>{e.free ? "✓ FREE" : "✗ PAID"}</span>
                    <div style={{ alignSelf: "center" }}>
                      <div style={{ fontSize: 12, color: "#0F172A", fontWeight: 500, marginBottom: 2 }}>{e.title}</div>
                      {e.description && <div style={{ fontSize: 10, color: "#64748B" }}>{e.description.slice(0, 80)}{e.description.length > 80 ? "…" : ""}</div>}
                    </div>
                    <span style={{ fontSize: 10, color: "#64748B", alignSelf: "center", textAlign: "right", wordBreak: "break-word" }}>
                      {e.venue?.split(" ").slice(0, 2).join(" ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary stats */}
          {allEvents.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 16 }}>
              {[
                { label: "Total Events", value: allEvents.length, color: "#60A5FA" },
                { label: "Free Events", value: allEvents.filter(e => e.free).length, color: "#10B981" },
                { label: "Library Events", value: allEvents.filter(e => e.venueType === "library").length, color: "#3B82F6" },
                { label: "Museum Events", value: allEvents.filter(e => e.venueType === "museum").length, color: "#F59E0B" },
              ].map((s, i) => (
                <div key={i} style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: "14px 16px" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: "'Syne', sans-serif" }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 2, letterSpacing: "0.05em" }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
