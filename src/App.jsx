import { useState, useEffect, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const TYPE_META = {
  library:     { label: "Library",     color: "#3B82F6" },
  museum:      { label: "Museum",      color: "#F59E0B" },
  gallery:     { label: "Gallery",     color: "#8B5CF6" },
  arts_centre: { label: "Arts Centre", color: "#10B981" },
};

const tc = (t) => TYPE_META[t]?.color || "#64748B";
const tl = (t) => TYPE_META[t]?.label || (t || "venue").replace(/_/g, " ");

async function api(path) {
  try {
    const r = await fetch(`${BACKEND}${path}`);
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const S = {
  page:    { padding: 28, maxWidth: 1200, margin: "0 auto" },
  section: { fontFamily: "'Syne',sans-serif", fontSize: 16, fontWeight: 700, marginBottom: 20 },
  chip:    { fontSize: 10, padding: "2px 8px", borderRadius: 2, border: "1px solid", letterSpacing: "0.04em" },
  card:    { background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4 },
  row:     { padding: "11px 16px", borderBottom: "1px solid #F1F5F9", display: "flex", alignItems: "center", gap: 12 },
  label:   { fontSize: 10, color: "#94A3B8", letterSpacing: "0.08em", marginBottom: 5 },
  mono:    { fontFamily: "'DM Mono',monospace" },
  btn:     (active) => ({
    padding: "7px 14px", fontSize: 11, borderRadius: 3, cursor: "pointer",
    fontFamily: "inherit", letterSpacing: "0.05em", border: "none",
    background: active ? "#1E293B" : "#F1F5F9",
    color:      active ? "#FFF"    : "#64748B",
  }),
  runBtn:  { padding: "8px 22px", fontSize: 11, background: "#2563EB", border: "none", borderRadius: 3, cursor: "pointer", color: "#FFF", fontFamily: "inherit", fontWeight: 600 },
  stopBtn: { padding: "8px 22px", fontSize: 11, background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 3, cursor: "pointer", color: "#DC2626", fontFamily: "inherit", fontWeight: 600 },
  input:   { padding: "8px 10px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 3, background: "#F8FAFC", fontFamily: "inherit", color: "#0F172A" },
  statCard: (color) => ({ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 4, padding: "16px 18px", borderTop: `3px solid ${color}` }),
};

function StatCards({ items }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 10, marginBottom: 20 }}>
      {items.map(({ label, val, color }) => (
        <div key={label} style={S.statCard(color)}>
          <div style={{ fontSize: 24, fontWeight: 700, color, fontFamily: "'Syne',sans-serif", ...S.mono }}>{val ?? "—"}</div>
          <div style={{ fontSize: 9, color: "#94A3B8", marginTop: 4, letterSpacing: "0.1em" }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

function TypeBadge({ type, small }) {
  return (
    <span style={{ ...S.chip, background: tc(type) + "18", color: tc(type), borderColor: tc(type) + "40", fontSize: small ? 9 : 10 }}>
      {small ? tl(type).slice(0, 3).toUpperCase() : tl(type)}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    active:        ["#10B981", "active"],
    failed:        ["#EF4444", "failed"],
    no_website:    ["#CBD5E1", "no website"],
    never_scraped: ["#F59E0B", "new"],
  };
  const [color, label] = map[status] || ["#94A3B8", status || "unknown"];
  if (!status) return null;
  return <span style={{ ...S.chip, background: color + "18", color, borderColor: color + "40" }}>{label}</span>;
}

// ─── L1: Venues ───────────────────────────────────────────────────────────────

function VenuesLayer({ city, setCity, goNext }) {
  const [cityInput, setCityInput] = useState(city || "");
  const [types,     setTypes]     = useState([]);
  const [webOnly,   setWebOnly]   = useState(false);
  const [venues,    setVenues]    = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [queried,   setQueried]   = useState(false);

  const toggleType = (t) => setTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const query = async () => {
    if (!cityInput.trim()) return;
    setLoading(true); setQueried(true);
    const p = new URLSearchParams();
    p.set("city", cityInput.trim());
    if (types.length) p.set("type", types.join(","));
    if (webOnly) p.set("has_website", "true");
    p.set("limit", "200");
    const d = await api(`/api/venues?${p}`);
    setVenues(d?.venues || []);
    setCity(cityInput.trim());
    setLoading(false);
  };

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <div style={S.section}>VENUE BROWSER</div>
      </div>

      <div style={{ ...S.card, padding: 20, marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 24, alignItems: "start" }}>
        <div>
          <div style={S.label}>CITY</div>
          <input
            value={cityInput}
            onChange={e => setCityInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && query()}
            placeholder="Austin, Boston, Seattle…"
            style={{ ...S.input, width: "100%", boxSizing: "border-box" }}
          />
        </div>

        <div>
          <div style={S.label}>TYPE</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(TYPE_META).map(([k, { label, color }]) => {
              const on = types.includes(k);
              return (
                <button key={k} onClick={() => toggleType(k)} style={{ padding: "6px 12px", fontSize: 11, borderRadius: 3, cursor: "pointer", border: `1px solid ${on ? color : "#E2E8F0"}`, background: on ? color + "18" : "#F8FAFC", color: on ? color : "#64748B", fontFamily: "inherit" }}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 18 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748B", cursor: "pointer" }}>
            <input type="checkbox" checked={webOnly} onChange={e => setWebOnly(e.target.checked)} />
            Website only
          </label>
          <button onClick={query} disabled={loading} style={{ ...S.runBtn, opacity: loading ? 0.6 : 1 }}>
            {loading ? "LOADING…" : "FIND VENUES"}
          </button>
        </div>
      </div>

      {queried && !loading && venues.length === 0 && (
        <div style={{ textAlign: "center", padding: 60, color: "#94A3B8", fontSize: 13 }}>
          No venues found. Try running this city in the Scheduler tab first.
        </div>
      )}

      {venues.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#94A3B8" }}>{venues.length} venues</div>
            <button onClick={goNext} style={{ ...S.runBtn, display: "flex", alignItems: "center", gap: 6 }}>
              RUN SCHEDULER <span style={{ opacity: 0.7 }}>→</span>
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {venues.map(v => (
              <div key={v.id} style={{ ...S.card, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, flex: 1 }}>{v.name}</div>
                  <TypeBadge type={v.type} />
                </div>
                <div style={{ fontSize: 11, color: "#64748B", marginBottom: 10 }}>{v.city || "—"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <StatusBadge status={v.scrape_status} />
                  {v.avg_events > 0 && (
                    <span style={{ fontSize: 10, color: "#2563EB", ...S.mono }}>avg {Number(v.avg_events).toFixed(1)} ev</span>
                  )}
                  {v.website && (
                    <a href={v.website} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "#2563EB", textDecoration: "none", marginLeft: "auto" }}>
                      site ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── L2: Scheduler ────────────────────────────────────────────────────────────

function SchedulerLayer({ city: initCity, setCity, goNext, onRunComplete }) {
  const [cityInput, setCityInput] = useState(initCity || "");
  const [radiusKm,  setRadiusKm]  = useState(30);
  const [running,   setRunning]   = useState(false);
  const [log,       setLog]       = useState([]);
  const [done,      setDone]      = useState(false);
  const [runId,     setRunId]     = useState(null);
  const [progress,  setProgress]  = useState({ done: 0, total: 0, events: 0, current: "" });
  const [traces,    setTraces]    = useState({});
  const [runStats,  setRunStats]  = useState(null);
  const logRef = useRef(null);
  const esRef  = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const run = async () => {
    if (running || !cityInput.trim()) return;
    setRunning(true); setLog([]); setDone(false); setTraces({}); setRunStats(null);
    setProgress({ done: 0, total: 0, events: 0, current: "starting…" });

    let rid;
    try {
      const res = await fetch(`${BACKEND}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: cityInput.trim(), radius_km: radiusKm }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLog([{ phase: "run_error", error: err.error || `HTTP ${res.status}` }]);
        setRunning(false); return;
      }
      const data = await res.json();
      rid = data.run_id;
      setRunId(rid);
      setCity(cityInput.trim());
    } catch {
      setLog([{ phase: "run_error", error: "Could not connect to backend" }]);
      setRunning(false); return;
    }

    const es = new EventSource(`${BACKEND}/api/run/${rid}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.phase === "venue_start") {
          setTraces(prev => ({ ...prev, [msg.venue_id]: { name: msg.venue_name, status: "running" } }));
          setProgress(p => ({ ...p, current: msg.venue_name }));
          return;
        }
        if (msg.phase === "venue_done") {
          setTraces(prev => ({ ...prev, [msg.venue_id]: { name: msg.venue_name, status: "done" } }));
          setProgress(p => ({ ...p, done: p.done + 1, events: p.events + (msg.events_found || 0) }));
          setLog(prev => [...prev, msg]);
          return;
        }
        if (msg.phase === "venue_error") {
          setTraces(prev => ({ ...prev, [msg.venue_id]: { name: msg.venue_name, status: "error" } }));
          setProgress(p => ({ ...p, done: p.done + 1 }));
          setLog(prev => [...prev, msg]);
          return;
        }
        if (msg.phase === "discovery_done") {
          setProgress(p => ({ ...p, total: msg.venues_total || 0 }));
          setLog(prev => [...prev, msg]);
          return;
        }
        if (msg.phase === "run_done") {
          setRunStats(msg);
          setRunning(false); setDone(true);
          onRunComplete?.(); es.close(); return;
        }
        if (msg.phase === "run_error") {
          setLog(prev => [...prev, msg]);
          setRunning(false); setDone(true);
          onRunComplete?.(); es.close(); return;
        }
        setLog(prev => [...prev, msg]);
      } catch {}
    };
    es.onerror = () => { es.close(); setRunning(false); };
  };

  const stop = async () => {
    if (runId) await fetch(`${BACKEND}/api/run/${runId}`, { method: "DELETE" }).catch(() => {});
    esRef.current?.close();
    setRunning(false);
  };

  const traceEntries = Object.entries(traces);

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={S.section}>SCHEDULER</div>
      </div>

      <div style={{ ...S.card, padding: 20, marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", marginBottom: 14 }}>RUN A CITY</div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={S.label}>CITY</div>
            <input
              value={cityInput}
              onChange={e => setCityInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && run()}
              placeholder="Austin, Boston, Seattle…"
              style={{ ...S.input, width: "100%", boxSizing: "border-box" }}
            />
          </div>
          <div>
            <div style={S.label}>RADIUS</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={5} max={100} step={5} value={radiusKm}
                onChange={e => setRadiusKm(Number(e.target.value))} />
              <span style={{ fontSize: 11, ...S.mono, minWidth: 40 }}>{radiusKm} km</span>
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            {running
              ? <button onClick={stop} style={S.stopBtn}>■ STOP</button>
              : <button onClick={run} disabled={!cityInput.trim()} style={{ ...S.runBtn, opacity: cityInput.trim() ? 1 : 0.5 }}>▶ RUN</button>}
          </div>
        </div>
      </div>

      {traceEntries.length > 0 && (
        <div style={{ ...S.card, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", borderBottom: "1px solid #E2E8F0", fontSize: 9, color: "#94A3B8", letterSpacing: "0.1em" }}>
            PIPELINE TRACE · {traceEntries.length} VENUES
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {traceEntries.map(([id, { name, status }]) => {
              const icon  = status === "running" ? "●" : status === "done" ? "✓" : status === "error" ? "✗" : "·";
              const color = status === "running" ? "#2563EB" : status === "done" ? "#10B981" : status === "error" ? "#EF4444" : "#E2E8F0";
              return (
                <div key={id} style={{ padding: "8px 14px", borderBottom: "1px solid #F8FAFC", display: "flex", alignItems: "center", gap: 10, opacity: status === "done" ? 0.55 : 1 }}>
                  <span style={{ fontSize: 12, color, animation: status === "running" ? "pulse 1s infinite" : "none" }}>{icon}</span>
                  <span style={{ fontSize: 11, color: "#334155" }}>{name}</span>
                </div>
              );
            })}
          </div>
          <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
        </div>
      )}

      {(running || done) && progress.total > 0 && (
        <div style={{ ...S.card, padding: "14px 18px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "#334155" }}>
              {running
                ? <><span style={{ color: "#F59E0B", marginRight: 6 }}>●</span>{progress.current || "running…"}</>
                : <><span style={{ color: "#10B981", marginRight: 6 }}>✔</span>batch complete</>}
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 11, ...S.mono }}>
              <span style={{ color: "#64748B" }}>{progress.done}/{progress.total} venues</span>
              <span style={{ color: "#2563EB" }}>{progress.events} events</span>
            </div>
          </div>
          <div style={{ height: 4, background: "#F1F5F9", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2,
              width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
              background: done ? "#10B981" : "#2563EB",
              transition: "width 0.4s ease",
            }} />
          </div>
        </div>
      )}

      {runStats && (
        <StatCards items={[
          { label: "VENUES SCRAPED", val: runStats.venues_done,     color: "#10B981" },
          { label: "VENUES FAILED",  val: runStats.venues_failed,   color: "#EF4444" },
          { label: "EVENTS FOUND",   val: runStats.events_found,    color: "#2563EB" },
          { label: "ACCEPTED",       val: runStats.events_accepted, color: "#10B981" },
        ]} />
      )}

      {log.length > 0 && (
        <div ref={logRef} style={{ background: "#0F172A", borderRadius: 4, padding: "14px 16px", marginBottom: 12, maxHeight: 220, overflowY: "auto", ...S.mono, fontSize: 11 }}>
          {log.map((m, i) => {
            const color =
              m.phase === "run_done"      ? "#10B981" :
              m.phase === "run_error"     ? "#EF4444" :
              m.phase === "venue_error"   ? "#EF4444" :
              m.phase === "venue_done"    ? (m.events_found > 0 ? "#60A5FA" : "#475569") :
              m.phase === "judging_done"  ? "#A78BFA" :
              m.phase === "kg_done"       ? "#F472B6" :
              "#64748B";
            const text =
              m.phase === "run_start"      ? `▶  Run started for ${m.city}` :
              m.phase === "discovery_done" ? `──  ${m.venues_total} venues found (${m.venues_with_website} with website)` :
              m.phase === "venue_done"     ? `   ${m.events_found > 0 ? "✓" : "○"}  ${m.venue_name}  —  ${m.events_found} events` :
              m.phase === "venue_error"    ? `   ✗  ${m.venue_name}: ${m.error}` :
              m.phase === "judging_start"  ? `──  Judging ${m.events_raw} events…` :
              m.phase === "judging_done"   ? `   ✓  ${m.events_accepted} accepted · ${m.events_review} review · ${m.events_rejected} rejected` :
              m.phase === "kg_done"        ? `   ✓  Knowledge graph: ${m.tagged_venues} venues tagged` :
              m.phase === "run_done"       ? `✔  Done` :
              m.phase === "run_error"      ? `✗  ${m.error}` :
              m.message || "";
            return <div key={i} style={{ color, lineHeight: 1.6 }}>{text}</div>;
          })}
          {running && <div style={{ color: "#F59E0B" }}>● running…</div>}
        </div>
      )}

      {done && !running && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
          <button onClick={goNext} style={{ ...S.runBtn, display: "flex", alignItems: "center", gap: 6 }}>
            VIEW EVENTS <span style={{ opacity: 0.7 }}>→</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── L3: Events ───────────────────────────────────────────────────────────────

function EventRow({ ev }) {
  const [open, setOpen] = useState(false);
  const q      = ev.quality_score ?? 0;
  const qColor = q >= 0.65 ? "#10B981" : q >= 0.35 ? "#F59E0B" : "#EF4444";
  return (
    <div style={{ borderBottom: "1px solid #F1F5F9" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "grid", gridTemplateColumns: "52px 1fr 120px 90px 18px", padding: "10px 14px", gap: 10, alignItems: "start", cursor: "pointer" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: qColor, ...S.mono }}>{(q * 100).toFixed(0)}%</div>
          <TypeBadge type={ev.venue_type} small />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{ev.title}</div>
          {!open && ev.description && (
            <div style={{ fontSize: 10, color: "#94A3B8" }}>{ev.description.slice(0, 80)}{ev.description.length > 80 ? "…" : ""}</div>
          )}
        </div>
        <div style={{ fontSize: 10, color: "#64748B" }}>{ev.venue_name?.slice(0, 22)}</div>
        <div style={{ fontSize: 11, color: "#2563EB", ...S.mono }}>{ev.date}</div>
        <div style={{ fontSize: 10, color: "#94A3B8", paddingTop: 2 }}>{open ? "▲" : "▼"}</div>
      </div>
      {open && (
        <div style={{ padding: "0 14px 14px 76px", display: "flex", flexDirection: "column", gap: 6 }}>
          {ev.description && <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.5 }}>{ev.description}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10, color: "#64748B" }}>
            {ev.venue_name && <span><strong>Venue:</strong> {ev.venue_name}</span>}
            {ev.venue_type && <span><strong>Type:</strong> {tl(ev.venue_type)}</span>}
            {ev.date       && <span><strong>Date:</strong> {ev.date}</span>}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {ev.url && (
              <a href={ev.url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 10, color: "#2563EB", textDecoration: "none", border: "1px solid #BFDBFE", borderRadius: 3, padding: "3px 8px" }}>
                Event page ↗
              </a>
            )}
            {ev.venue_website && (
              <a href={ev.venue_website} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 10, color: "#7C3AED", textDecoration: "none", border: "1px solid #DDD6FE", borderRadius: 3, padding: "3px 8px" }}>
                Venue site ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VenueGroup({ venueName, events }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ borderBottom: "1px solid #E2E8F0" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", cursor: "pointer", background: "#F8FAFC" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#1E293B" }}>{venueName}</span>
        <span style={{ fontSize: 10, color: "#94A3B8" }}>{events.length} event{events.length !== 1 ? "s" : ""}</span>
        <span style={{ fontSize: 10, color: "#94A3B8", marginLeft: "auto" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && events.map((ev, i) => <EventRow key={`${ev.title}-${i}`} ev={ev} />)}
    </div>
  );
}

function EventsLayer({ city, goNext, runVersion }) {
  const [counts,    setCounts]    = useState(null);
  const [verdict,   setVerdict]   = useState("accept");
  const [events,    setEvents]    = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [localKey,  setLocalKey]  = useState(0);
  const [search,    setSearch]    = useState("");
  const [dateFrom,  setDateFrom]  = useState("");
  const [dateTo,    setDateTo]    = useState("");
  const [sortAsc,   setSortAsc]   = useState(true);
  const [groupMode, setGroupMode] = useState(false);

  useEffect(() => {
    if (!city) return;
    Promise.all(
      ["accept", "review", "reject"].map(v =>
        api(`/api/events?city=${encodeURIComponent(city)}&verdict=${v}&limit=500`)
          .then(d => [v, d?.events?.length ?? 0])
      )
    ).then(pairs => setCounts(Object.fromEntries(pairs)));
  }, [city, runVersion, localKey]);

  useEffect(() => {
    if (!city) return;
    setLoading(true);
    api(`/api/events?city=${encodeURIComponent(city)}&verdict=${verdict}&limit=500`)
      .then(d => { setEvents(d?.events || []); setLoading(false); });
  }, [verdict, city, runVersion, localKey]);

  const vc    = { accept: "#10B981", review: "#F59E0B", reject: "#EF4444" };
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;

  const filtered = events.filter(ev => {
    if (search) {
      const q = search.toLowerCase();
      if (!(ev.title || "").toLowerCase().includes(q) &&
          !(ev.description || "").toLowerCase().includes(q) &&
          !(ev.venue_name || "").toLowerCase().includes(q)) return false;
    }
    if (dateFrom && ev.date && ev.date < dateFrom) return false;
    if (dateTo   && ev.date && ev.date > dateTo)   return false;
    return true;
  }).sort((a, b) => {
    const da = a.date || "", db = b.date || "";
    return sortAsc ? da.localeCompare(db) : db.localeCompare(da);
  });

  const grouped = groupMode
    ? filtered.reduce((acc, ev) => {
        const key = ev.venue_name || "Unknown";
        (acc[key] = acc[key] || []).push(ev);
        return acc;
      }, {})
    : null;

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ ...S.section, marginBottom: 0 }}>EVENTS</div>
        {city  && <span style={{ fontSize: 11, color: "#94A3B8" }}>{city}</span>}
        {total > 0 && <span style={{ fontSize: 11, color: "#94A3B8" }}>{total} total</span>}
        {city && (
          <button onClick={() => setLocalKey(k => k + 1)} style={{ ...S.btn(false), padding: "5px 10px", fontSize: 10 }}>
            ↺ REFRESH
          </button>
        )}
        {total > 0 && (
          <button onClick={goNext} style={{ marginLeft: "auto", ...S.btn(false), padding: "5px 12px", fontSize: 10 }}>
            KNOWLEDGE GRAPH →
          </button>
        )}
      </div>

      {!city && (
        <div style={{ textAlign: "center", padding: 60, color: "#94A3B8", fontSize: 13 }}>
          Run a city in the Scheduler tab first.
        </div>
      )}

      {city && counts && (
        <StatCards items={[
          { label: "ACCEPT", val: counts.accept, color: "#10B981" },
          { label: "REVIEW", val: counts.review, color: "#F59E0B" },
          { label: "REJECT", val: counts.reject, color: "#EF4444" },
          { label: "TOTAL",  val: total,         color: "#CBD5E1" },
        ]} />
      )}

      {city && total === 0 && (
        <div style={{ textAlign: "center", padding: 60, color: "#94A3B8", fontSize: 13 }}>
          No events yet — run the scheduler to populate.
        </div>
      )}

      {city && total > 0 && (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {["accept", "review", "reject"].map(v => (
              <button key={v} onClick={() => setVerdict(v)} style={{ padding: "5px 12px", fontSize: 10, borderRadius: 3, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.06em", background: verdict === v ? vc[v] : "#F8FAFC", color: verdict === v ? "#FFF" : vc[v], border: `1px solid ${vc[v]}50` }}>
                {v.toUpperCase()}
              </button>
            ))}
            <button onClick={() => setGroupMode(g => !g)} style={{ ...S.btn(groupMode), padding: "5px 10px", fontSize: 10 }}>
              {groupMode ? "LIST" : "GROUP BY VENUE"}
            </button>
            <button onClick={() => setSortAsc(a => !a)} style={{ ...S.btn(false), padding: "5px 10px", fontSize: 10 }}>
              DATE {sortAsc ? "↑" : "↓"}
            </button>
            {loading && <span style={{ fontSize: 10, color: "#94A3B8" }}>loading…</span>}
            <span style={{ fontSize: 10, color: "#94A3B8" }}>{filtered.length} shown</span>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <input placeholder="Search title, description, venue…" value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...S.input, flex: "1 1 220px", minWidth: 180 }} />
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#94A3B8" }}>FROM</span>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...S.input, fontSize: 11 }} />
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#94A3B8" }}>TO</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...S.input, fontSize: 11 }} />
            </div>
            {(search || dateFrom || dateTo) && (
              <button onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); }}
                style={{ ...S.btn(false), padding: "5px 10px", fontSize: 10, color: "#EF4444" }}>
                ✕ CLEAR
              </button>
            )}
          </div>

          <div style={S.card}>
            <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 120px 90px 18px", padding: "8px 14px", borderBottom: "1px solid #E2E8F0", fontSize: 9, color: "#94A3B8", letterSpacing: "0.1em", gap: 10 }}>
              <span>SCORE</span><span>EVENT</span><span>VENUE</span><span>DATE</span><span></span>
            </div>
            <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
              {!groupMode && filtered.map((ev, i) => <EventRow key={`${ev.title}-${i}`} ev={ev} />)}
              {groupMode && Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([name, evs]) => (
                <VenueGroup key={name} venueName={name} events={evs} />
              ))}
              {filtered.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#94A3B8", fontSize: 12 }}>
                  No events match your filters.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── L4: Knowledge Graph ──────────────────────────────────────────────────────

function KnowledgeLayer({ city }) {
  const [tagCloud,      setTagCloud]      = useState([]);
  const [selectedTag,   setSelectedTag]   = useState("");
  const [tagResults,    setTagResults]    = useState([]);
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [card,          setCard]          = useState(null);
  const [entityInput,   setEntityInput]   = useState("");
  const [entityResults, setEntityResults] = useState([]);
  const [tab,           setTab]           = useState("tags");

  useEffect(() => {
    if (!city) return;
    api(`/api/graph/tags?city=${encodeURIComponent(city)}`)
      .then(d => setTagCloud(d?.tags || []));
  }, [city]);

  useEffect(() => {
    if (!selectedVenue) { setCard(null); return; }
    api(`/api/graph/venue/${encodeURIComponent(selectedVenue.id)}`).then(setCard);
  }, [selectedVenue]);

  const clickTag = async (tag) => {
    setSelectedTag(tag); setSelectedVenue(null);
    const r = await api(`/api/graph/search?city=${encodeURIComponent(city)}&tag=${encodeURIComponent(tag)}&limit=40`);
    setTagResults(r?.venues || []);
  };

  const searchEntity = async () => {
    if (!entityInput.trim()) return;
    const r = await api(`/api/graph/search?city=${encodeURIComponent(city)}&entity=${encodeURIComponent(entityInput)}&limit=30`);
    setEntityResults(r?.venues || []);
  };

  if (!city) return (
    <div style={S.page}>
      <div style={{ textAlign: "center", padding: 60, color: "#94A3B8", fontSize: 13 }}>
        Run a city in the Scheduler tab first.
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={S.section}>KNOWLEDGE GRAPH</div>
        <span style={{ fontSize: 11, color: "#94A3B8" }}>{city}</span>
        {tagCloud.length > 0 && <>
          <span style={{ fontSize: 11, color: "#94A3B8" }}>·</span>
          <span style={{ fontSize: 11, color: "#94A3B8" }}>{tagCloud.length} tags</span>
        </>}
      </div>

      {tagCloud.length === 0 && (
        <div style={{ textAlign: "center", padding: 60, color: "#94A3B8", fontSize: 13 }}>
          Graph is empty — run the scheduler to build it automatically.
        </div>
      )}

      {tagCloud.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
            {[["tags", "BROWSE BY TAG"], ["entities", "ENTITY SEARCH"]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={S.btn(tab === k)}>{l}</button>
            ))}
          </div>

          {tab === "tags" && (
            <div style={{ display: "grid", gridTemplateColumns: selectedVenue ? "1fr 300px" : "1fr", gap: 20 }}>
              <div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: "#94A3B8", letterSpacing: "0.08em", marginBottom: 10 }}>SELECT A TAG</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {tagCloud.map(({ tag, venue_count, avg_weight }) => (
                      <button key={tag} onClick={() => clickTag(tag)} style={{
                        padding: "5px 12px", fontSize: 11, borderRadius: 20, cursor: "pointer", fontFamily: "inherit",
                        background: selectedTag === tag ? "#2563EB" : "#F1F5F9",
                        color:      selectedTag === tag ? "#FFF"     : "#334155",
                        border:     selectedTag === tag ? "none"     : "1px solid #E2E8F0",
                        opacity:    0.5 + (avg_weight || 0.5) * 0.5,
                      }}>
                        {tag.replace(/_/g, " ")}
                        <span style={{ fontSize: 9, marginLeft: 5, opacity: 0.6 }}>{venue_count}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {tagResults.length > 0 && (
                  <div style={S.card}>
                    <div style={{ padding: "8px 14px", borderBottom: "1px solid #E2E8F0", fontSize: 10, color: "#94A3B8", letterSpacing: "0.1em" }}>
                      {tagResults.length} venues · {selectedTag.replace(/_/g, " ")}
                    </div>
                    <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
                      {tagResults.map((v) => (
                        <div key={v.id} onClick={() => setSelectedVenue(s => s?.id === v.id ? null : v)}
                          style={{ ...S.row, cursor: "pointer", justifyContent: "space-between", background: selectedVenue?.id === v.id ? "#EFF6FF" : "transparent" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500 }}>{v.name}</div>
                            <div style={{ fontSize: 10, color: "#94A3B8" }}>{v.city || city}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                            <TypeBadge type={v.type} small />
                            <div style={{ width: 36, height: 4, background: "#F1F5F9", borderRadius: 2, overflow: "hidden" }}>
                              <div style={{ width: `${((v.weight || 0) * 100).toFixed(0)}%`, height: "100%", background: "#2563EB", borderRadius: 2 }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {selectedVenue && (
                <div style={{ ...S.card, padding: 18, alignSelf: "start", position: "sticky", top: 20 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{selectedVenue.name}</div>
                      <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 2 }}>{city}</div>
                    </div>
                    <button onClick={() => setSelectedVenue(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 16 }}>✕</button>
                  </div>

                  {!card && <div style={{ fontSize: 11, color: "#94A3B8", textAlign: "center", padding: 16 }}>Loading…</div>}

                  {card && (<>
                    {card.tags?.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 9, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 8 }}>PROGRAMMING PROFILE</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {card.tags.map(({ tag, weight }) => (
                            <span key={tag} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: `rgba(37,99,235,${0.08 + weight * 0.18})`, color: "#2563EB", border: "1px solid rgba(37,99,235,0.15)" }}>
                              {tag.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {card.similar?.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 9, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 8 }}>SIMILAR VENUES</div>
                        {card.similar.map((s) => (
                          <div key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #F8FAFC", fontSize: 11 }}>
                            <span style={{ color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{s.name}</span>
                            <span style={{ color: "#94A3B8", fontSize: 10, ...S.mono, flexShrink: 0 }}>{(s.score * 100).toFixed(0)}%</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {card.entities?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, color: "#94A3B8", letterSpacing: "0.1em", marginBottom: 8 }}>ENTITIES DETECTED</div>
                        {card.entities.slice(0, 8).map((e, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 10, color: "#64748B" }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>{e.entity_name}</span>
                            <span style={{ fontSize: 9, color: "#CBD5E1", flexShrink: 0 }}>{e.entity_type}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {selectedVenue.website && (
                      <a href={selectedVenue.website} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", marginTop: 14, fontSize: 10, color: "#2563EB", textDecoration: "none" }}>
                        {selectedVenue.website.replace(/^https?:\/\//, "").slice(0, 38)} ↗
                      </a>
                    )}
                  </>)}
                </div>
              )}
            </div>
          )}

          {tab === "entities" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <input value={entityInput} onChange={e => setEntityInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && searchEntity()}
                  placeholder="Artist name, exhibition title, series…"
                  style={{ ...S.input, flex: 1 }} />
                <button onClick={searchEntity} style={S.runBtn}>SEARCH</button>
              </div>
              {entityResults.length > 0 && (
                <div style={S.card}>
                  {entityResults.map((v, i) => (
                    <div key={i} style={{ ...S.row, justifyContent: "space-between" }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{v.name}</div>
                        <div style={{ fontSize: 10, color: "#94A3B8" }}>{v.city} · {v.entity_type ?? ""}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <TypeBadge type={v.type} small />
                        {v.website && <a href={v.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#2563EB", textDecoration: "none" }}>↗</a>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {entityResults.length === 0 && entityInput && (
                <div style={{ textAlign: "center", padding: 40, color: "#94A3B8", fontSize: 12 }}>No results found.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── App shell ────────────────────────────────────────────────────────────────

const LAYERS = [
  { label: "L1", name: "Venues" },
  { label: "L2", name: "Scheduler" },
  { label: "L3", name: "Events" },
  { label: "L4", name: "Knowledge" },
];

export default function App() {
  const [layer,      setLayer]      = useState(1);
  const [city,       setCity]       = useState("");
  const [runVersion, setRunVersion] = useState(0);

  return (
    <div style={{ minHeight: "100vh", background: "#F8FAFC", fontFamily: "'DM Mono', 'SF Mono', monospace" }}>
      <div style={{ background: "#FFF", borderBottom: "1px solid #E2E8F0", padding: "16px 28px", display: "flex", alignItems: "center", gap: 24, position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em" }}>
            URBAN <span style={{ color: "#2563EB" }}>RHYTHM</span>
          </div>
          <div style={{ fontSize: 9, color: "#94A3B8", marginTop: 1, letterSpacing: "0.12em" }}>MULTI-AGENT · GLOBAL · SELF-LEARNING</div>
        </div>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {LAYERS.map(({ label, name }, i) => (
            <button key={i} onClick={() => setLayer(i)} style={{ ...S.btn(layer === i), padding: "7px 16px" }}>
              <span style={{ opacity: 0.5, marginRight: 6 }}>{label}</span>{name}
            </button>
          ))}
        </div>
      </div>

      {layer === 0 && <VenuesLayer city={city} setCity={setCity} goNext={() => setLayer(1)} />}
      {layer === 1 && <SchedulerLayer city={city} setCity={setCity} goNext={() => setLayer(2)} onRunComplete={() => setRunVersion(v => v + 1)} />}
      {layer === 2 && <EventsLayer city={city} goNext={() => setLayer(3)} runVersion={runVersion} />}
      {layer === 3 && <KnowledgeLayer city={city} />}
    </div>
  );
}
