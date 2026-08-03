"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";

const EMPTY = { title: "", due_date: "", status: "on_track", team_id: "", owner_id: "", description: "" };

export default function RocksPage() {
  const { activeTenantId } = useAuth();
  const [rocks, setRocks] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);

  function load() {
    apiFetch("/rocks").then(setRocks).catch((e) => setError(e.message));
    apiFetch("/teams").then(setTeams).catch(() => {});
    apiFetch("/directory").then(setPeople).catch(() => {});
  }
  useEffect(() => { setRocks(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function createRock(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/rocks", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, status: f.status,
        due_date: f.due_date || null, team_id: f.team_id || null,
        owner_id: f.owner_id || null, description: f.description || null,
      })});
      setF(EMPTY); setOpen(false); load();
    } catch (e) { setError(e.message); }
  }
  async function setStatus(id, status) {
    try { await apiFetch(`/rocks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function delRock(id) {
    if (!confirm("Delete this Rock?")) return;
    try { await apiFetch(`/rocks/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Rocks</h1>
          <p className="page-sub">Set and track this tenant&rsquo;s priorities.</p>
        </div>
        {activeTenantId && <button className="btn-secondary" onClick={() => setOpen(true)}>+ Create Rock</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!rocks && !error && <p className="loading-line">Loading rocks…</p>}
      {rocks && rocks.length === 0 && (
        <div className="empty-state"><p className="display">No Rocks set yet</p><p>Create this tenant&rsquo;s top priorities.</p></div>
      )}

      {rocks && rocks.map((r) => (
        <div className="card" key={r.id}>
          <div className="card-row">
            <div>
              <p className="card-title">{r.title}</p>
              {r.description && <p className="card-meta">{r.description}</p>}
              <p className="card-meta">
                Owner: {r.owner_name || "Unassigned"}
                {r.team_name ? ` · Team: ${r.team_name}` : ""}
                {r.due_date ? ` · Due ${r.due_date}` : ""}
              </p>
            </div>
            <div className="card-controls">
              <select className="status-select" value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}>
                <option value="on_track">on track</option>
                <option value="off_track">off track</option>
                <option value="complete">complete</option>
              </select>
              <button className="link-danger" onClick={() => delRock(r.id)}>Delete</button>
            </div>
          </div>
        </div>
      ))}

      <Modal open={open} onClose={() => setOpen(false)} accent="Rock" onSubmit={createRock} submitDisabled={!f.title.trim()}>
        <label className="fld">Title<input value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a title for the Rock…" /></label>
        <div className="fld-row-3">
          <label className="fld">Due date<input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></label>
          <label className="fld">Status
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="on_track">On-track</option>
              <option value="off_track">Off-track</option>
              <option value="complete">Complete</option>
            </select>
          </label>
          <label className="fld">Owner
            <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
              <option value="">You</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <label className="fld">Team
          <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="fld">Description <span className="fld-opt">(optional)</span>
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Add a description…" />
        </label>
      </Modal>
    </div>
  );
}
