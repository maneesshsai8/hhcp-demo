"use client";
import { useEffect, useState } from "react";
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

export default function MeetingsPage() {
  const { activeTenantId, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState("upcoming");
  const [meetings, setMeetings] = useState(null);
  const [agendas, setAgendas] = useState([]);
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [error, setError] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [sched, setSched] = useState({ title: "", scheduled_at: "" });

  function load() {
    apiFetch("/meetings").then(setMeetings).catch((e) => setError(e.message));
    apiFetch("/meetings/agendas").then(setAgendas).catch(() => {});
    apiFetch("/teams").then(setTeams).catch(() => {});
  }
  useEffect(() => { setMeetings(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  const upcoming = (meetings || []).filter((m) => m.status !== "completed");
  const past = (meetings || []).filter((m) => m.status === "completed");

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
        past.length === 0 ? <div className="empty-state"><p className="display">No past meetings</p><p>Completed meetings land here with their duration and rating.</p></div> : (
          <div className="card">
            <p className="card-title">Meeting History <span className="count-chip">{past.length}</span></p>
            <table className="history-table">
              <thead><tr><th>Date</th><th>Agenda</th><th>Duration</th><th>Facilitator</th><th>Rating</th></tr></thead>
              <tbody>
                {past.map((m) => (
                  <tr key={m.id}>
                    <td>{m.ended_at ? new Date(m.ended_at).toLocaleString() : "—"}</td>
                    <td>{m.title}</td>
                    <td>{fmtDuration(m.duration_seconds)}</td>
                    <td>{m.created_by_name || "—"}</td>
                    <td>{m.rating != null ? m.rating : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ---------------- Agendas ---------------- */}
      {meetings && tab === "agendas" && (
        <>
          {agendas.map((a) => (
            <div className="card" key={a.key}>
              <div className="card-row">
                <div>
                  <p className="card-title">📅 {a.name}</p>
                  <p className="card-meta">{a.type} · {a.sections.length} sections · {a.total_minutes} min total</p>
                </div>
                {activeTenantId && can("create") && <button className="btn-mini" onClick={() => startMeeting(a.key)}>Start</button>}
              </div>
              <div className="agenda-sections">
                {a.sections.map((s, i) => (
                  <div className="agenda-sec" key={s.key}>
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
          {agendas.map((a) => (
            <button type="button" key={a.key} className="agenda-pick" onClick={() => startMeeting(a.key)}>
              <span>📅 {a.name}</span>
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
