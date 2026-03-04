import { useState, useCallback } from "react";

const VENUES = [
  {
    id: 1, type: "library", name: "Parkway Central Library",
    address: "1901 Vine St, Philadelphia, PA 19103",
    lat: 39.9595647, lng: -75.1710445, rating: 4.6,
    website: "https://www.freelibrary.org/events",
    color: "#3B82F6"
  },
  {
    id: 2, type: "library", name: "Northeast Regional Library",
    address: "2228 Cottman Ave, Philadelphia, PA 19149",
    lat: 40.0481284, lng: -75.0614917, rating: 4.1,
    website: "https://www.freelibrary.org/events",
    color: "#3B82F6"
  },
  {
    id: 3, type: "library", name: "South Philadelphia Library",
    address: "1700 S Broad St, Philadelphia, PA 19145",
    lat: 39.9291433, lng: -75.1690827, rating: 4.6,
    website: "https://www.freelibrary.org/events",
    color: "#3B82F6"
  },
  {
    id: 4, type: "museum", name: "Philadelphia Museum of Art",
    address: "2600 Benjamin Franklin Pkwy, Philadelphia, PA 19130",
    lat: 39.9655697, lng: -75.1809661, rating: 4.8,
    website: "https://www.philamuseum.org/calendar",
    color: "#F59E0B"
  },
  {
    id: 5, type: "museum", name: "The Franklin Institute",
    address: "222 N 20th St, Philadelphia, PA 19103",
    lat: 39.9582109, lng: -75.1731347, rating: 4.6,
    website: "https://www.fi.edu/events",
    color: "#F59E0B"
  },
  {
    id: 6, type: "museum", name: "Philadelphia's Magic Gardens",
    address: "1020 South St, Philadelphia, PA 19147",
    lat: 39.9426127, lng: -75.159357, rating: 4.6,
    website: "https://www.phillymagicgardens.org/events",
    color: "#F59E0B"
  },
  {
    id: 7, type: "museum", name: "Please Touch Museum",
    address: "4231 Avenue of the Republic, Philadelphia, PA 19131",
    lat: 39.9794964, lng: -75.209147, rating: 4.6,
    website: "https://www.pleasetouchmuseum.org/events",
    color: "#F59E0B"
  },
  {
    id: 8, type: "museum", name: "Academy of Natural Sciences",
    address: "1900 Benjamin Franklin Pkwy, Philadelphia, PA 19103",
    lat: 39.9568422, lng: -75.1712897, rating: 4.6,
    website: "https://ansp.org/events",
    color: "#F59E0B"
  },
];

const LAYER_LABELS = ["Layer 1", "Layer 2", "Layer 3"];
const LAYER_NAMES = ["地理定位", "活动爬取", "数据存档"];

async function scrapeVenueEvents(venue) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        content: `Search for upcoming events at: ${venue.name}, Philadelphia. Check their website: ${venue.website}. Return the JSON array of events only.`
      }]
    })
  });
  const data = await response.json();
  const textBlock = data.content?.find(b => b.type === "text");
  if (!textBlock) return [];
  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
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

  const startScraping = useCallback(async () => {
    setScraping(true);
    setAllEvents([]);
    setScrapeStatus({});
    const results = [];

    for (const venue of VENUES) {
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
  }, []);

  const categories = ["all", ...new Set(allEvents.map(e => e.category).filter(Boolean))];
  const filteredEvents = allEvents.filter(e =>
    (filterType === "all" || e.venueType === filterType) &&
    (filterCat === "all" || e.category === filterCat)
  );

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
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0" }}>地理定位索引</div>
            <div style={{ fontSize: 11, color: "#4A5568", padding: "3px 8px", border: "1px solid #1E2533", borderRadius: 2 }}>{VENUES.length} VENUES</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11 }}>
              <span style={{ color: "#3B82F6" }}>● LIBRARY ({VENUES.filter(v=>v.type==="library").length})</span>
              <span style={{ color: "#F59E0B" }}>● MUSEUM ({VENUES.filter(v=>v.type==="museum").length})</span>
            </div>
          </div>

          {/* Mini map visualization */}
          <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, padding: 20, marginBottom: 20, position: "relative", height: 200, overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, #1A1F2E 1px, transparent 0)", backgroundSize: "20px 20px", opacity: 0.5 }} />
            <div style={{ position: "relative", fontSize: 10, color: "#4A5568", marginBottom: 8, letterSpacing: "0.1em" }}>GEO MAP · Philadelphia Bounding Box [39.867–40.138 N, -75.280–-74.956 W]</div>
            <svg width="100%" height="160" style={{ position: "absolute", left: 0, top: 30 }}>
              {VENUES.map(v => {
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
            {VENUES.map(v => (
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

          <div style={{ marginTop: 20, textAlign: "center" }}>
            <button className="scrape-btn" onClick={() => { setLayer(1); startScraping(); }}
              style={{ padding: "12px 32px", fontSize: 12, borderRadius: 3, letterSpacing: "0.08em" }}>
              ▶ 启动 LAYER 2 · 活动爬取
            </button>
          </div>
        </div>
      )}

      {/* Layer 2: Scraping */}
      {layer === 1 && (
        <div style={{ padding: 28 }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0", marginBottom: 20 }}>
            活动爬取 · Web Scraping Pipeline
          </div>
          <div style={{ background: "#0F1117", border: "1px solid #1E2533", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #1E2533", fontSize: 10, color: "#4A5568", letterSpacing: "0.1em", display: "flex", justifyContent: "space-between" }}>
              <span>VENUE</span>
              <span style={{ display: "flex", gap: 40 }}><span>STATUS</span><span>EVENTS FOUND</span></span>
            </div>
            {VENUES.map(v => {
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
                <div className="progress-fill" style={{ width: `${(Object.keys(scrapeStatus).length / VENUES.length) * 100}%` }} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: "#4A5568" }}>{Object.keys(scrapeStatus).length}/{VENUES.length} 场馆处理中</span>
            {!scraping && allEvents.length > 0 && (
              <button className="scrape-btn" onClick={() => setLayer(2)}
                style={{ padding: "8px 20px", fontSize: 11, borderRadius: 3 }}>
                查看 Layer 3 · 数据表格 →
              </button>
            )}
          </div>

          {/* Live event feed */}
          {allEvents.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, color: "#4A5568", marginBottom: 10, letterSpacing: "0.1em" }}>LIVE FEED · {allEvents.length} 条活动已捕获</div>
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
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#E2E8F0" }}>数据存档 · Event Archive</div>
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
                  爬取中…
                </span>
              )}
            </div>
          </div>

          {allEvents.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#4A5568" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⚙</div>
              <div style={{ fontSize: 13 }}>尚未爬取数据</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>请先前往 Layer 1 启动爬取流程</div>
              <button className="scrape-btn" onClick={() => setLayer(0)}
                style={{ padding: "10px 24px", fontSize: 11, borderRadius: 3, marginTop: 16 }}>
                ← 返回 Layer 1
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
                  <div style={{ padding: 30, textAlign: "center", color: "#4A5568", fontSize: 12 }}>无匹配记录</div>
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
                { label: "总活动数", value: allEvents.length, color: "#60A5FA" },
                { label: "免费活动", value: allEvents.filter(e => e.free).length, color: "#10B981" },
                { label: "图书馆活动", value: allEvents.filter(e => e.venueType === "library").length, color: "#3B82F6" },
                { label: "博物馆活动", value: allEvents.filter(e => e.venueType === "museum").length, color: "#F59E0B" },
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
