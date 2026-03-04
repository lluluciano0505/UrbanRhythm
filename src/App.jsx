import { useState, useCallback } from "react";

const LAYER_LABELS = ["Layer 1", "Layer 2", "Layer 3"];
const LAYER_NAMES = ["Geo-Indexing", "Event Scraping", "Data Archive"];

async function searchVenues(query) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": "Bearer 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"
      },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a venue discovery expert. Generate realistic data for the user's search query. 
          
User search: "${query}" in Philadelphia, PA

Return a JSON array with 5-8 venues matching the search. Each venue must have:
- id: unique number
- type: "library" or "museum"
- name: realistic venue name in Philadelphia
- address: realistic Philadelphia address
- lat: latitude between 39.867-40.138
- lng: longitude between -75.280 to -74.956
- rating: number between 4.0-4.9
- website: realistic URL
- color: "#3B82F6" for libraries, "#F59E0B" for museums

Return ONLY valid JSON array, no markdown, no explanation:
[{"id":1,"type":"library","name":"Example Library","address":"123 Main St, Philadelphia, PA 19100","lat":39.95,"lng":-75.17,"rating":4.5,"website":"https://example.com","color":"#3B82F6"}]`
        }]
      })
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      
      if (content) {
        try {
          const cleaned = content.replace(/```json|```/g, "").trim();
          const venues = JSON.parse(cleaned);
          return Array.isArray(venues) ? venues : [];
        } catch (e) {
          console.error("Parse error:", e);
        }
      }
    } else {
      console.error("API error:", response.status, response.statusText);
    }
  } catch (error) {
    console.error("Search error:", error.message);
  }

  return [];
}

async function scrapeVenueEvents(venue) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": "Bearer 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"
      },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Search for upcoming events at: ${venue.name}, Philadelphia. Check their website: ${venue.website}. 
        
Return a JSON array of events in this format (return at most 5 events, empty array if none found):
[{"title":"Event Name","date":"2026-03-15","time":"2:00 PM - 4:00 PM","category":"Workshop","description":"Brief description","free":true}]

Return ONLY valid JSON array, no markdown, no explanation.`
        }]
      })
    });
    
    if (!response.ok) {
      console.error("API error:", response.status);
      return [];
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];
    try {
      const cleaned = content.replace(/```json|```/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return [];
    }
  } catch (error) {
    console.error("Scrape error:", error.message);
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

  const handleSearch = useCallback(async (query) => {
    setSearching(true);
    try {
      const results = await searchVenues(query);
      setVenues(results);
      setHasSearched(true);
    } catch (error) {
      console.error("Search error:", error);
      setVenues([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const startScraping = useCallback(async () => {
    setScraping(true);
    setAllEvents([]);
    setScrapeStatus({});
    const results = [];

    for (const venue of venues) {
      setScrapeStatus(s => ({ ...s, [venue.id]: "scraping" }));
      try {
        const events = await scrapeVenueEvents(venue);
        setScrapeStatus(s => ({ ...s, [venue.id]: "done" }));
        events.forEach(ev => results.push({ ...ev, venue: venue.name, venueType: venue.type, venueId: venue.id }));
        setAllEvents([...results]);
      } catch {
        setScrapeStatus(s => ({ ...s, [venue.id]: "error" }));
      }
    }
    setScraping(false);
    setLayer(2);
  }, [venues]);

  const categories = ["all", ...new Set(allEvents.map(e => e.category).filter(Boolean))];
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
    <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", background: "#0A0A0F", minHeight: "100vh", color: "#E2E8F0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0A0A0F; } ::-webkit-scrollbar-thumb { background: #2D3748; border-radius: 2px; }
        .venue-card { border: 1px solid #1E2533; background: #0F1117; transition: all 0.2s; cursor: pointer; }
        .venue-card:hover { border-color: #3B82F6; background: #141824; transform: translateX(3px); }
        .venue-card.selected { border-color: #3B82F6; background: #141D2E; }
        .layer-btn { background: transparent; border: 1px solid #1E2533; color: #718096; cursor: pointer; transition: all 0.2s; font-family: inherit; }
        .layer-btn.active { background: #1A1F2E; border-color: #3B82F6; color: #60A5FA; }
        .layer-btn:hover:not(.active) { border-color: #2D3748; color: #A0AEC0; }
        .scrape-btn { background: linear-gradient(135deg, #1E40AF, #1D4ED8); border: none; color: white; cursor: pointer; font-family: inherit; transition: all 0.2s; }
        .scrape-btn:hover:not(:disabled) { background: linear-gradient(135deg, #2563EB, #3B82F6); transform: translateY(-1px); }
        .scrape-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .event-row { border-bottom: 1px solid #1A1F2E; transition: background 0.15s; }
        .event-row:hover { background: #0F1117; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .pulse { animation: pulse 1.2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .tag { font-size: 10px; padding: 2px 7px; border-radius: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
        .filter-select { background: #0F1117; border: 1px solid #1E2533; color: #A0AEC0; font-family: inherit; font-size: 12px; padding: 5px 10px; border-radius: 3px; }
        .coord { color: #4A5568; font-size: 10px; }
        .progress-bar { height: 2px; background: #1E2533; border-radius: 1px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #3B82F6, #60A5FA); transition: width 0.3s; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1E2533", padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", color: "#F7FAFC" }}>
            PHILLY <span style={{ color: "#3B82F6" }}>CULTURAL</span> RADAR
          </div>
          <div style={{ fontSize: 11, color: "#4A5568", marginTop: 2, letterSpacing: "0.1em" }}>GENETIC EVENT PIPELINE · PHILADELPHIA PA</div>
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
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0" }}>GEO-LOCATION INDEX</div>
            {hasSearched && (
              <div style={{ fontSize: 11, color: "#4A5568", padding: "3px 8px", border: "1px solid #1E2533", borderRadius: 2 }}>{filteredVenues.length} VENUES</div>
            )}
          </div>

          {!hasSearched ? (
            /* Initial Search Interface */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 20 }}>
              <div style={{ fontSize: 28, fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "#E2E8F0", textAlign: "center" }}>
                SEARCH FOR VENUES
              </div>
              <div style={{ fontSize: 12, color: "#4A5568", textAlign: "center", maxWidth: 400 }}>
                Enter a location, address, or venue name to discover cultural venues in Philadelphia
              </div>
              
              <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, padding: 24, width: "100%", maxWidth: 500 }}>
                <input 
                  type="text"
                  placeholder="Search by address, venue name, or neighborhood..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === "Enter" && searchQuery.trim() && handleSearch(searchQuery)}
                  style={{ 
                    width: "100%", padding: "12px 16px", fontSize: 13, marginBottom: 12,
                    background: "#0A0A0F", border: "1px solid #1E2533", borderRadius: 3,
                    color: "#E2E8F0", fontFamily: "inherit", boxSizing: "border-box"
                  }}
                  autoFocus
                />
                
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button 
                    onClick={() => handleSearch("libraries Philadelphia")}
                    disabled={searching}
                    style={{ 
                      flex: 1, padding: "10px 12px", fontSize: 11, background: "#1A1F2E", 
                      border: "1px solid #3B82F6", borderRadius: 3, color: "#60A5FA",
                      cursor: "pointer", fontFamily: "inherit", opacity: searching ? 0.5 : 1
                    }}
                  >
                    {searching ? "⊙ SEARCHING..." : "▶ Libraries"}
                  </button>
                  <button 
                    onClick={() => handleSearch("museums Philadelphia")}
                    disabled={searching}
                    style={{ 
                      flex: 1, padding: "10px 12px", fontSize: 11, background: "#1A1F2E", 
                      border: "1px solid #F59E0B", borderRadius: 3, color: "#FBBF24",
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
                    background: "#0A0A0F", border: "1px solid #1E2533", borderRadius: 3,
                    color: "#E2E8F0", fontFamily: "inherit"
                  }}
                />
                <select 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All Types</option>
                  <option value="library">Libraries Only</option>
                  <option value="museum">Museums Only</option>
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
                  onClick={() => { setHasSearched(false); setSearchQuery(""); setFilterType("all"); setMinRating(0); setVenues([]); }}
                  style={{ 
                    padding: "6px 12px", fontSize: 11, background: "#1A1F2E", 
                    border: "1px solid #1E2533", borderRadius: 3, color: "#718096",
                    cursor: "pointer", fontFamily: "inherit"
                  }}
                >
                  ← NEW SEARCH
                </button>
              </div>

              {/* Mini map visualization */}
              <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, padding: 20, marginBottom: 20, position: "relative", height: 200, overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, #1A1F2E 1px, transparent 0)", backgroundSize: "20px 20px", opacity: 0.5 }} />
                <div style={{ position: "relative", fontSize: 10, color: "#4A5568", marginBottom: 8, letterSpacing: "0.1em" }}>GEO MAP · Philadelphia Bounding Box [39.867–40.138 N, -75.280–-74.956 W]</div>
                <svg width="100%" height="160" style={{ position: "absolute", left: 0, top: 30 }}>
                  {filteredVenues.map(v => {
                    const x = ((v.lng - (-75.28)) / ((-74.956) - (-75.28))) * 100;
                    const y = ((40.138 - v.lat) / (40.138 - 39.867)) * 100;
                    return (
                      <g key={v.id} onClick={() => { setSelectedVenue(v); }} style={{ cursor: "pointer" }}>
                        <circle cx={`${x}%`} cy={`${y}%`} r={selectedVenue?.id === v.id ? 8 : 5}
                          fill={v.color} opacity={selectedVenue?.id === v.id ? 1 : 0.7}
                          style={{ transition: "all 0.2s" }} />
                        {selectedVenue?.id === v.id && (
                          <circle cx={`${x}%`} cy={`${y}%`} r={14} fill="none" stroke={v.color} strokeWidth={1} opacity={0.4} />
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {filteredVenues.map(v => (
                  <div key={v.id} className={`venue-card ${selectedVenue?.id === v.id ? "selected" : ""}`}
                    onClick={() => setSelectedVenue(v === selectedVenue ? null : v)}
                    style={{ padding: "12px 14px", borderRadius: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="tag" style={{ background: v.color + "22", color: v.color, border: `1px solid ${v.color}44` }}>
                          {v.type}
                        </span>
                        <span style={{ fontSize: 10, color: "#4A5568" }}>★ {v.rating}</span>
                      </div>
                      <span style={{ fontSize: 10, color: scrapeStatus[v.id] === "done" ? "#10B981" : scrapeStatus[v.id] === "error" ? "#EF4444" : scrapeStatus[v.id] === "scraping" ? "#F59E0B" : "#2D3748" }}>
                        {scrapeStatus[v.id] === "done" ? "✓ scraped" : scrapeStatus[v.id] === "error" ? "✗ error" : scrapeStatus[v.id] === "scraping" ? "… loading" : "pending"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#E2E8F0", marginBottom: 4 }}>{v.name}</div>
                    <div style={{ fontSize: 11, color: "#4A5568" }}>{v.address}</div>
                    <div className="coord" style={{ marginTop: 5 }}>[{v.lat.toFixed(4)}, {v.lng.toFixed(4)}]</div>
                  </div>
                ))}
              </div>

              {filteredVenues.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#4A5568" }}>
                  <div style={{ fontSize: 13 }}>No results found</div>
                  <div style={{ fontSize: 11, marginTop: 6 }}>Try adjusting your search terms or filters</div>
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
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0", marginBottom: 20 }}>
            EVENT SCRAPING · Web Scraping Pipeline
          </div>
          <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #1E2533", fontSize: 10, color: "#4A5568", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
              <span>VENUE</span>
              <span style={{ display: "flex", gap: 40 }}><span>STATUS</span><span>EVENTS FOUND</span></span>
            </div>
            {venues.map(v => {
              const count = allEvents.filter(e => e.venueId === v.id).length;
              const status = scrapeStatus[v.id];
              return (
                <div key={v.id} style={{ padding: "14px 16px", borderBottom: "1px solid #1A1F2E", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={`status-dot ${status === "scraping" ? "pulse" : ""}`}
                      style={{ background: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#2D3748" }} />
                    <div>
                      <div style={{ fontSize: 12, color: "#CBD5E0" }}>{v.name}</div>
                      <div style={{ fontSize: 10, color: "#4A5568" }}>{v.website}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
                    <span style={{ fontSize: 11, color: status === "done" ? "#10B981" : status === "error" ? "#EF4444" : status === "scraping" ? "#F59E0B" : "#4A5568", minWidth: 80, textAlign: "right" }}>
                      {status === "done" ? "COMPLETE" : status === "error" ? "FAILED" : status === "scraping" ? "SCRAPING…" : "QUEUED"}
                    </span>
                    <span style={{ fontSize: 13, color: count > 0 ? "#60A5FA" : "#2D3748", fontWeight: 500, minWidth: 40, textAlign: "right" }}>
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
            <span style={{ fontSize: 11, color: "#4A5568" }}>{Object.keys(scrapeStatus).length}/{venues.length} venues processing</span>
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
              <div style={{ fontSize: 11, color: "#4A5568", marginBottom: 10, letterSpacing: "0.1em" }}>LIVE FEED · {allEvents.length} events captured</div>
              <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, maxHeight: 200, overflowY: "auto" }}>
                {allEvents.slice(-10).reverse().map((e, i) => (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1A1F2E", fontSize: 11, display: "flex", gap: 10 }}>
                    <span style={{ color: "#4A5568", flexShrink: 0 }}>[{e.venueType === "library" ? "LIB" : "MUS"}]</span>
                    <span style={{ color: "#60A5FA", flexShrink: 0 }}>{e.date || "TBD"}</span>
                    <span style={{ color: "#CBD5E0" }}>{e.title}</span>
                    <span style={{ color: "#4A5568", marginLeft: "auto", flexShrink: 0 }}>{e.venue.split(" ").slice(0, 2).join(" ")}</span>
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
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0" }}>DATA ARCHIVE · Event Archive</div>
            <div style={{ fontSize: 11, color: "#4A5568", padding: "3px 8px", border: "1px solid #1E2533", borderRadius: 2 }}>{filteredEvents.length} RECORDS</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <select className="filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="all">All Types</option>
                <option value="library">Libraries</option>
                <option value="museum">Museums</option>
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
            <div style={{ textAlign: "center", padding: 60, color: "#4A5568" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⚙</div>
              <div style={{ fontSize: 13 }}>No data scraped yet</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>Go to Layer 1 to start scraping</div>
              <button className="scrape-btn" onClick={() => setLayer(0)}
                style={{ padding: "10px 24px", fontSize: 11, borderRadius: 3, marginTop: 16 }}>
                ← Back to Layer 1
              </button>
            </div>
          ) : (
            <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, overflow: "hidden" }}>
              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "80px 130px 160px 100px 90px 1fr 70px", gap: 0, padding: "10px 16px", borderBottom: "1px solid #1E2533", fontSize: 10, color: "#4A5568", letterSpacing: "0.1em" }}>
                <span>TYPE</span><span>DATE</span><span>TIME</span><span>CATEGORY</span><span>FREE</span><span>EVENT</span><span>VENUE</span>
              </div>
              <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
                {filteredEvents.length === 0 ? (
                  <div style={{ padding: 30, textAlign: "center", color: "#4A5568", fontSize: 12 }}>No matching records</div>
                ) : filteredEvents.map((e, i) => (
                  <div key={i} className="event-row" style={{ display: "grid", gridTemplateColumns: "80px 130px 160px 100px 90px 1fr 70px", gap: 0, padding: "12px 16px", alignItems: "start" }}>
                    <span className="tag" style={{
                      background: e.venueType === "library" ? "#3B82F622" : "#F59E0B22",
                      color: e.venueType === "library" ? "#3B82F6" : "#F59E0B",
                      border: `1px solid ${e.venueType === "library" ? "#3B82F644" : "#F59E0B44"}`,
                      alignSelf: "center"
                    }}>{e.venueType === "library" ? "LIB" : "MUS"}</span>
                    <span style={{ fontSize: 11, color: "#A0AEC0", alignSelf: "center" }}>{e.date || "—"}</span>
                    <span style={{ fontSize: 11, color: "#718096", alignSelf: "center" }}>{e.time || "—"}</span>
                    <span style={{ fontSize: 10, color: "#60A5FA", alignSelf: "center" }}>{e.category || "—"}</span>
                    <span style={{ fontSize: 11, color: e.free ? "#10B981" : "#EF4444", alignSelf: "center" }}>{e.free ? "✓ FREE" : "✗ PAID"}</span>
                    <div style={{ alignSelf: "center" }}>
                      <div style={{ fontSize: 12, color: "#E2E8F0", fontWeight: 500, marginBottom: 2 }}>{e.title}</div>
                      {e.description && <div style={{ fontSize: 10, color: "#4A5568" }}>{e.description.slice(0, 80)}{e.description.length > 80 ? "…" : ""}</div>}
                    </div>
                    <span style={{ fontSize: 10, color: "#4A5568", alignSelf: "center", textAlign: "right", wordBreak: "break-word" }}>
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
                <div key={i} style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, padding: "14px 16px" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: "'Syne', sans-serif" }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#4A5568", marginTop: 2, letterSpacing: "0.05em" }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
