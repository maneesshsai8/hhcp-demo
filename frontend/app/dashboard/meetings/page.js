"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";

function fmtDuration(s) {
  if (s == null) return "—";
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60), sec = s % 60;
  return sec ? `${m} min ${sec} sec` : `${m} min`;
}

/* Build & download an .ics calendar invite for a scheduled meeting. */
function downloadIcs(m) {
  const start = m.scheduled_at ? new Date(m.scheduled_at) : new Date();
  const end = new Date(start.getTime() + 90 * 60 * 1000);
  const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => (s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HHCP//Meetings//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${m.id}@hhcp`,
    `DTSTAMP:${z(start)}`,
    `DTSTART:${z(start)}`,
    `DTEND:${z(end)}`,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc("HHCP EOS meeting" + (m.created_by_name ? ` · facilitator ${m.created_by_name}` : ""))}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url; a.download = `${(m.title || "meeting").replace(/[^\w]+/g, "-")}.ics`;
  a.click(); URL.revokeObjectURL(url);
}

const SEG_KINDS = [
  ["segue", "Segue / check-in"], ["scorecard", "Scorecard"], ["rocks", "Rock Review"],
  ["vcbs", "VCB Review"], ["todos", "To-Do List"], ["issues", "IDS (Issues)"],
  ["text", "Discussion / notes"], ["conclude", "Conclude & rate"],
];
const BLANK_SEG = () => ({ key: "", label: "", minutes: 5, kind: "text", prompt: "" });

export default function MeetingsPage() {
  const { activeTenantId, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState("upcoming");
  const [meetings, setMeetings] = useState(null);
  const [agendas, setAgendas] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [trend, setTrend] = useState(null);
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [error, setError] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [sched, setSched] = useState({ title: "", scheduled_at: "" });

  // archive search (Past tab)
  const [q, setQ] = useState("");
  const [since, setSince] = useState("");
  const [filterTeam, setFilterTeam] = useState("");
  const [archive, setArchive] = useState(null);

  // custom agenda template builder
  const [builderOpen, setBuilderOpen] = useState(false);
  const [tpl, setTpl] = useState({ name: "", sections: [BLANK_SEG()] });

  const load = useCallback(() => {
    apiFetch("/meetings").then(setMeetings).catch((e) => setError(e.message));
    apiFetch("/meetings/agendas").then(setAgendas).catch(() => {});
    apiFetch("/meetings/templates/list").then(setTemplates).catch(() => {});
    apiFetch("/meetings/ratings/trend").then(setTrend).catch(() => {});
    apiFetch("/teams").then(setTeams).catch(() => {});
  }, []);
  useEffect(() => { setMeetings(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  const searchArchive = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (since) p.set("since", new Date(since).toISOString());
    if (filterTeam) p.set("team_id", filterTeam);
    apiFetch(`/meetings?${p.toString()}`)
      .then((rows) => setArchive(rows.filter((m) => m.status === "completed")))
      .catch((e) => setError(e.message));
  }, [q, since, filterTeam]);
  useEffect(() => { if (tab === "past") searchArchive(); /* eslint-disable-next-line */ }, [tab, activeTenantId]);

  const upcoming = (meetings || []).filter((m) => m.status !== "completed");
  const allAgendas = [...agendas, ...templates.map((t) => ({ key: t.id, name: t.name, type: "Custom", total_minutes: (t.sections || []).reduce((a, s) => a + (Number(s.minutes) || 0), 0), sections: t.sections || [], custom: true }))];

  async function startMeeting(agenda_key) {
    try {
      const res = await apiFetch("/meetings/start", { method: "POST", body: JSON.stringify({ tenant_id: activeTenantId, agenda_key, team_id: teamId || null }) });
      router.push(`/dashboard/meetings/${res.id}`);
    } catch (e) { setError(e.message); }
  }
  async function schedule(e) {
    e.preventDefault();
    if (!sched.title.trim()) return;
    try {
      await apiFetch("/meetings", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: sched.title,
        scheduled_at: sched.scheduled_at ? new Date(sched.scheduled_at).toISOString() : null,
      })});
      setSched({ title: "", scheduled_at: "" }); setSchedOpen(false); load();
    } catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm("Delete this meeting?")) return;
    try { await apiFetch(`/meetings/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  // ---- template builder ----
  function setSeg(i, patch) { setTpl((t) => ({ ...t, sections: t.sections.map((s, j) => j === i ? { ...s, ...patch } : s) })); }
  function addSeg() { setTpl((t) => ({ ...t, sections: [...t.sections, BLANK_SEG()] })); }
  function removeSeg(i) { setTpl((t) => ({ ...t, sections: t.sections.filter((_, j) => j !== i) })); }
  async function saveTemplate(e) {
    e.preventDefault();
    if (!tpl.name.trim() || !activeTenantId) return;
    const sections = tpl.sections
      .filter((s) => s.label.trim())
      .map((s, i) => ({ key: s.key || `seg${i + 1}`, label: s.label, minutes: Number(s.minutes) || 5, kind: s.kind, prompt: s.prompt || "" }));
    if (!sections.length) { setError("Add at least one segment with a label."); return; }
    try {
      await apiFetch("/meetings/templates", { method: "POST", body: JSON.stringify({ tenant_id: activeTenantId, name: tpl.name, sections }) });
      setTpl({ name: "", sections: [BLANK_SEG()] }); setBuilderOpen(false);
      apiFetch("/meetings/templates/list").then(setTemplates).catch(() => {});
    } catch (e) { setError(e.message); }
  }
  async function delTemplate(id) {
    if (!confirm("Delete this custom agenda?")) return;
    try { await apiFetch(`/meetings/templates/${id}`, { method: "DELETE" }); apiFetch("/meetings/templates/list").then(setTemplates).catch(() => {}); }
    catch (e) { setError(e.message); }
  }

  return (
    <div>
      <h1 className="page-title display">Meetings</h1>
      <p className="page-sub">Run structured EOS meetings and keep the history.</p>

      <div className="subtabs">
        {["upcoming", "past", "agendas"].map((t) => (
          <button key={t} className={`subtab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "upcoming" ? "Upcoming" : t === "past" ? "Past Meetings" : "Agendas"}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!meetings && !error && <p className="loading-line">Loading…</p>}

      {/* ---------------- Upcoming ---------------- */}
      {meetings && tab === "upcoming" && (
        <>
          <div className="meeting-cta card">
            <div>
              <p className="card-title">Ready to meet?</p>
              <p className="card-meta">
                {!activeTenantId
                  ? "Pick a PortCo in the top-left switcher to start or schedule a meeting."
                  : !can("create")
                    ? "Your role can view meetings but not start them."
                    : "Start a live meeting from an agenda, or schedule one for later."}
              </p>
            </div>
            <div className="head-actions">
              <button className="btn-secondary" disabled={!activeTenantId || !can("create")} onClick={() => setPickOpen(true)}>▶ Start a Meeting</button>
              <button className="btn-ghost" disabled={!activeTenantId || !can("create")} onClick={() => setSchedOpen(true)}>Schedule a Meeting</button>
            </div>
          </div>
          {upcoming.length === 0 && <div className="empty-state"><p className="display">Nothing upcoming</p><p>Start or schedule a meeting above.</p></div>}
          {upcoming.map((m) => (
            <div className="card" key={m.id}>
              <div className="card-row">
                <div>
                  <p className="card-title">{m.title}</p>
                  <p className="card-meta">
                    {m.status === "in_progress" ? "In progress" : "Scheduled"}
                    {m.scheduled_at ? ` · ${new Date(m.scheduled_at).toLocaleString()}` : ""}
                  </p>
                </div>
                <div className="card-controls">
                  {m.status !== "in_progress" && <button className="btn-mini ghost" onClick={() => downloadIcs(m)} title="Add to calendar">📅 .ics</button>}
                  {m.status === "in_progress"
                    ? <button className="btn-secondary" onClick={() => router.push(`/dashboard/meetings/${m.id}`)}>● Join Live</button>
                    : can("delete") && <button className="link-danger" onClick={() => del(m.id)}>Delete</button>}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* ---------------- Past ---------------- */}
      {meetings && tab === "past" && (
        <>
          {/* ratings trend */}
          {trend && trend.points.length > 0 && (
            <div className="card">
              <div className="card-row">
                <p className="card-title">Meeting rating trend</p>
                <span className="card-meta">avg {trend.average} · last {trend.count}</span>
              </div>
              <div className="trend-bars">
                {trend.points.map((p) => {
                  const cls = p.rating >= 8 ? "high" : p.rating >= 6 ? "mid" : "low";
                  return (
                    <div className="trend-bar-wrap" key={p.id} title={`${p.title} · ${p.rating}/10${p.at ? ` · ${new Date(p.at).toLocaleDateString()}` : ""}`}>
                      <div className={`trend-bar ${cls}`} style={{ height: `${Math.max(6, (p.rating / 10) * 78)}px` }} />
                      <span className="trend-bar-val">{p.rating}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* archive search */}
          <div className="filter-bar">
            <input className="mini-input" style={{ minWidth: 220 }} placeholder="Search title, notes, summary…" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchArchive()} />
            <select className="mini-input" value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input className="mini-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} title="On or after" />
            <button className="btn-mini" onClick={searchArchive}>Search</button>
            {(q || since || filterTeam) && <button className="btn-mini ghost" onClick={() => { setQ(""); setSince(""); setFilterTeam(""); setTimeout(searchArchive, 0); }}>Clear</button>}
          </div>

          {!archive ? <p className="loading-line">Loading…</p> : archive.length === 0 ? (
            <div className="empty-state"><p className="display">No past meetings</p><p>{(q || since || filterTeam) ? "No completed meetings match your search." : "Completed meetings land here with their duration and rating."}</p></div>
          ) : (
            <div className="card">
              <p className="card-title">Meeting History <span className="count-chip">{archive.length}</span></p>
              <table className="history-table">
                <thead><tr><th>Date</th><th>Agenda</th><th>Duration</th><th>Facilitator</th><th>Rating</th><th></th></tr></thead>
                <tbody>
                  {archive.map((m) => (
                    <tr key={m.id} className="clickable" onClick={() => router.push(`/dashboard/meetings/${m.id}`)} title="View summary">
                      <td>{m.ended_at ? new Date(m.ended_at).toLocaleString() : "—"}</td>
                      <td>{m.title}</td>
                      <td>{fmtDuration(m.duration_seconds)}</td>
                      <td>{m.created_by_name || "—"}</td>
                      <td>{m.rating != null ? m.rating : "—"}</td>
                      <td><span className="link-muted">View →</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ---------------- Agendas ---------------- */}
      {meetings && tab === "agendas" && (
        <>
          <div className="page-head-row">
            <p className="card-meta">Built-in EOS agendas and your saved custom templates.</p>
            {activeTenantId && can("create") && <button className="btn-secondary" onClick={() => setBuilderOpen((b) => !b)}>{builderOpen ? "Cancel" : "+ Build custom agenda"}</button>}
          </div>

          {builderOpen && (
            <form className="card inline-form" onSubmit={saveTemplate}>
              <label className="fld">Agenda name<input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} placeholder="Monthly Ops Review" required /></label>
              <p className="mini-label">Segments</p>
              {tpl.sections.map((s, i) => (
                <div className="tpl-seg-row" key={i}>
                  <input placeholder="Segment label" value={s.label} onChange={(e) => setSeg(i, { label: e.target.value })} />
                  <input type="number" min="1" placeholder="min" value={s.minutes} onChange={(e) => setSeg(i, { minutes: e.target.value })} />
                  <select value={s.kind} onChange={(e) => setSeg(i, { kind: e.target.value })}>
                    {SEG_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button type="button" className="link-danger" onClick={() => removeSeg(i)} title="Remove">✕</button>
                </div>
              ))}
              <div className="head-actions">
                <button type="button" className="btn-mini ghost" onClick={addSeg}>+ Add segment</button>
                <button type="submit" className="btn-secondary">Save agenda</button>
              </div>
            </form>
          )}

          {allAgendas.map((a) => (
            <div className="card" key={a.key}>
              <div className="card-row">
                <div>
                  <p className="card-title">📅 {a.name} {a.custom && <span className="freq-tag">custom</span>}</p>
                  <p className="card-meta">{a.type} · {a.sections.length} sections · {a.total_minutes} min total</p>
                </div>
                <div className="card-controls">
                  {activeTenantId && can("create") && <button className="btn-mini" onClick={() => startMeeting(a.key)}>Start</button>}
                  {a.custom && can("delete") && <button className="link-danger" onClick={() => delTemplate(a.key)}>Delete</button>}
                </div>
              </div>
              <div className="agenda-sections">
                {a.sections.map((s, i) => (
                  <div className="agenda-sec" key={s.key || i}>
                    <span className="agenda-sec-n">{i + 1}</span>
                    <span className="agenda-sec-label">{s.label}</span>
                    <span className="agenda-sec-min">{s.minutes} min</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Start-a-meeting agenda picker */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} prefix="Start" accent="Meeting"
        submitLabel="Close" onSubmit={(e) => { e.preventDefault(); setPickOpen(false); }}>
        {teams.length > 0 && (
          <label className="fld">Team (who this meeting is for)
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Whole tenant</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <p className="fld-opt" style={{ marginBottom: 10 }}>Select an agenda to start the live meeting</p>
        <div className="agenda-pick-list">
          {allAgendas.map((a) => (
            <button type="button" key={a.key} className="agenda-pick" onClick={() => startMeeting(a.key)}>
              <span>📅 {a.name} {a.custom && <span className="freq-tag">custom</span>}</span>
              <span className="agenda-sec-min">{a.total_minutes} min</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Schedule-a-meeting */}
      <Modal open={schedOpen} onClose={() => setSchedOpen(false)} prefix="Schedule" accent="Meeting"
        onSubmit={schedule} submitDisabled={!sched.title.trim()} submitLabel="Schedule">
        <label className="fld">Title<input value={sched.title} autoFocus onChange={(e) => setSched({ ...sched, title: e.target.value })} placeholder="Weekly L10" /></label>
        <label className="fld">Date & time<input type="datetime-local" value={sched.scheduled_at} onChange={(e) => setSched({ ...sched, scheduled_at: e.target.value })} /></label>
      </Modal>
    </div>
  );
}
