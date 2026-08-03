"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const STATUSES = ["scheduled", "in_progress", "completed"];

export default function MeetingsPage() {
  const { activeTenantId, can } = useAuth();
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState("");
  const [m, setM] = useState({ title: "", scheduled_at: "" });

  function load() { apiFetch("/meetings").then(setMeetings).catch((e) => setError(e.message)); }
  useEffect(() => { setMeetings(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function create(e) {
    e.preventDefault();
    if (!activeTenantId || !m.title.trim()) return;
    try {
      await apiFetch("/meetings", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: m.title,
        scheduled_at: m.scheduled_at ? new Date(m.scheduled_at).toISOString() : null,
      })});
      setM({ title: "", scheduled_at: "" }); load();
    } catch (e) { setError(e.message); }
  }
  async function setStatus(id, status) {
    try { await apiFetch(`/meetings/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function saveNotes(id, notes) {
    try { await apiFetch(`/meetings/${id}`, { method: "PATCH", body: JSON.stringify({ notes }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm("Delete this meeting?")) return;
    try { await apiFetch(`/meetings/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <h1 className="page-title display">Meetings</h1>
      <p className="page-sub">Weekly leadership (L10) meetings for this tenant.</p>

      {error && <div className="error-banner">{error}</div>}

      {activeTenantId && can("create") && (
        <form className="new-item-form" onSubmit={create}>
          <input placeholder="Meeting title, e.g. Weekly L10" value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />
          <input className="inline-select" type="datetime-local" value={m.scheduled_at} onChange={(e) => setM({ ...m, scheduled_at: e.target.value })} />
          <button className="btn-secondary" type="submit">Schedule</button>
        </form>
      )}

      {!meetings && !error && <p className="loading-line">Loading meetings…</p>}
      {meetings && meetings.length === 0 && (
        <div className="empty-state"><p className="display">No meetings scheduled</p><p>Schedule this tenant&rsquo;s first L10 above.</p></div>
      )}

      {meetings && meetings.map((mt) => (
        <div className="card" key={mt.id}>
          <div className="card-row">
            <div>
              <p className="card-title">{mt.title}</p>
              <p className="card-meta">
                {mt.scheduled_at ? new Date(mt.scheduled_at).toLocaleString() : "No date set"}
                {mt.created_by_name ? ` · by ${mt.created_by_name}` : ""}
              </p>
            </div>
            <div className="card-controls">
              <select className="status-select" value={mt.status} onChange={(e) => setStatus(mt.id, e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
              {can("delete") && <button className="link-danger" onClick={() => del(mt.id)}>Delete</button>}
            </div>
          </div>
          <textarea className="notes-box" defaultValue={mt.notes || ""} placeholder="Meeting notes…"
            onBlur={(e) => { if (e.target.value !== (mt.notes || "")) saveNotes(mt.id, e.target.value); }} />
        </div>
      ))}
    </div>
  );
}
