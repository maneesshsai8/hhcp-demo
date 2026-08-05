"use client";
import { useEffect, useState } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";
import MultiSelect from "@/components/MultiSelect";

const EMPTY = { title: "", due_date: "", status: "on_track", team_id: "", assignee_ids: [], description: "", workstream_id: "" };

export default function RocksPage() {
  const { activeTenantId, can } = useAuth();
  const [rocks, setRocks] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);       // tenant directory (fallback when no team picked)
  const [teamMembers, setTeamMembers] = useState([]); // members of the team picked in the modal
  const [vcbs, setVcbs] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);

  function load() {
    apiFetch("/rocks").then(setRocks).catch((e) => setError(e.message));
    apiFetch(`/teams${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setTeams).catch(() => {});
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {});
    apiFetch("/vcbs").then(setVcbs).catch(() => {});
  }
  useEffect(() => { setRocks(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  const wsOptions = vcbs.flatMap((v) => v.workstreams.map((w) => ({ id: w.id, label: `${v.title} › ${w.name}` })));

  // Assignee options are driven by the selected team: pick a team → only its members.
  const assigneeOptions = f.team_id ? teamMembers : people;

  async function pickTeam(team_id) {
    setF((s) => ({ ...s, team_id, assignee_ids: [] }));
    if (!team_id) { setTeamMembers([]); return; }
    try { setTeamMembers(await apiFetch(`/teams/${team_id}/members`)); }
    catch { setTeamMembers([]); }
  }
  const toggleAssignee = (id) =>
    setF((s) => ({ ...s, assignee_ids: s.assignee_ids.includes(id) ? s.assignee_ids.filter((x) => x !== id) : [...s.assignee_ids, id] }));

  function openModal() { setF(EMPTY); setTeamMembers([]); setOpen(true); }

  async function createRock(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/rocks", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, status: f.status,
        due_date: f.due_date || null, team_id: f.team_id || null,
        assignee_ids: f.assignee_ids.length ? f.assignee_ids : null,
        description: f.description || null, workstream_id: f.workstream_id || null,
      })});
      setF(EMPTY); setTeamMembers([]); setOpen(false); load();
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
        <div className="head-actions">
          {activeTenantId && rocks && rocks.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/rocks.xlsx?tenant_id=${activeTenantId}`, "rocks.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/rocks.pdf?tenant_id=${activeTenantId}`, "rocks.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="btn-secondary" onClick={openModal}>+ Create Rock</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!rocks && !error && <p className="loading-line">Loading rocks…</p>}
      {rocks && rocks.length === 0 && (
        <div className="empty-state"><p className="display">No Rocks set yet</p><p>Create this tenant&rsquo;s top priorities.</p></div>
      )}

      {rocks && rocks.map((r) => {
        const owners = (r.assignees && r.assignees.length) ? r.assignees.map((a) => a.name).join(", ") : (r.owner_name || "Unassigned");
        return (
          <div className="card" key={r.id}>
            <div className="card-row">
              <div>
                <p className="card-title">{r.title} {r.workstream_name && <span className="freq-tag" title={`${r.vcb_title} › ${r.workstream_name}`}>↑ {r.vcb_title}</span>}</p>
                {r.description && <p className="card-meta">{r.description}</p>}
                <p className="card-meta">
                  {r.assignees && r.assignees.length > 1 ? "Owners" : "Owner"}: {owners}
                  {r.team_name ? ` · Team: ${r.team_name}` : ""}
                  {r.workstream_name ? ` · ${r.workstream_name}` : ""}
                  {r.due_date ? ` · Due ${r.due_date}` : ""}
                </p>
              </div>
              <div className="card-controls">
                <select className="status-select" value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}>
                  <option value="on_track">on track</option>
                  <option value="off_track">off track</option>
                  <option value="complete">complete</option>
                </select>
                {can("delete") && <button className="link-danger" onClick={() => delRock(r.id)}>Delete</button>}
              </div>
            </div>
          </div>
        );
      })}

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
          <label className="fld">Team
            <select value={f.team_id} onChange={(e) => pickTeam(e.target.value)}>
              <option value="">No team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>

        <label className="fld">Assignees {f.team_id ? <span className="fld-opt">(from selected team)</span> : <span className="fld-opt">(tenant members)</span>}
          <MultiSelect
            options={assigneeOptions}
            selected={f.assignee_ids}
            onToggle={toggleAssignee}
            placeholder="Select assignees…"
            empty={f.team_id ? "This team has no members yet." : "No members in this tenant."}
          />
        </label>

        <label className="fld">Ladders up to (VCB › Workstream) <span className="fld-opt">(optional)</span>
          <select value={f.workstream_id} onChange={(e) => setF({ ...f, workstream_id: e.target.value })}>
            <option value="">Not linked to a VCB</option>
            {wsOptions.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
        <label className="fld">Description <span className="fld-opt">(optional)</span>
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Add a description…" />
        </label>
      </Modal>
    </div>
  );
}
