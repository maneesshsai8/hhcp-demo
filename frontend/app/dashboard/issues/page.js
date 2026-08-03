"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";

const EMPTY = { title: "", priority: "", team_id: "", description: "" };

export default function IssuesPage() {
  const { activeTenantId } = useAuth();
  const [issues, setIssues] = useState(null);
  const [teams, setTeams] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);

  function load() {
    apiFetch("/issues").then(setIssues).catch((e) => setError(e.message));
    apiFetch("/teams").then(setTeams).catch(() => {});
  }
  useEffect(() => { setIssues(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function createIssue(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/issues", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title,
        priority: f.priority || null, team_id: f.team_id || null, description: f.description || null,
      })});
      setF(EMPTY); setOpen(false); load();
    } catch (e) { setError(e.message); }
  }
  async function toggleStatus(i) {
    const status = i.status === "open" ? "solved" : "open";
    try { await apiFetch(`/issues/${i.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function delIssue(id) {
    if (!confirm("Delete this issue?")) return;
    try { await apiFetch(`/issues/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Issues</h1>
          <p className="page-sub">Identify and organize the issues that need attention.</p>
        </div>
        {activeTenantId && <button className="btn-secondary" onClick={() => setOpen(true)}>+ Create Issue</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!issues && !error && <p className="loading-line">Loading issues…</p>}
      {issues && issues.length === 0 && (
        <div className="empty-state"><p className="display">No open issues</p><p>Nothing raised here yet — that&rsquo;s a good sign.</p></div>
      )}

      {issues && issues.map((i) => (
        <div className="card" key={i.id}>
          <div className="card-row">
            <div>
              <p className="card-title">{i.title}</p>
              {i.description && <p className="card-meta">{i.description}</p>}
              <p className="card-meta">
                Raised by {i.created_by_name || "system"}
                {i.priority ? ` · ${i.priority} priority` : ""}
                {i.team_name ? ` · Team: ${i.team_name}` : ""}
              </p>
            </div>
            <div className="card-controls">
              <span className={`badge ${i.status}`}>{i.status}</span>
              <button className="btn-mini" onClick={() => toggleStatus(i)}>{i.status === "open" ? "Mark solved" : "Reopen"}</button>
              <button className="link-danger" onClick={() => delIssue(i.id)}>Delete</button>
            </div>
          </div>
        </div>
      ))}

      <Modal open={open} onClose={() => setOpen(false)} accent="Issue" onSubmit={createIssue} submitDisabled={!f.title.trim()}>
        <label className="fld">Title<input value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a title for the Issue…" /></label>
        <div className="fld-row-2">
          <label className="fld">Priority <span className="fld-opt">(optional)</span>
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">Select a priority…</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="fld">Team
            <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}>
              <option value="">No team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <label className="fld">Description <span className="fld-opt">(optional)</span>
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Add a description…" />
        </label>
      </Modal>
    </div>
  );
}
