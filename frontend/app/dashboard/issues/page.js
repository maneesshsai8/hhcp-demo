"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";

const EMPTY = { title: "", priority: "", category: "", team_id: "", owner_id: "", vcb_id: "", description: "" };

export default function IssuesPage() {
  const { activeTenantId, can } = useAuth();
  const [issues, setIssues] = useState(null);
  const [stats, setStats] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);   // members of the team picked in the modal
  const [vcbs, setVcbs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [tab, setTab] = useState("open");        // 'open' | 'solved'
  const [teamF, setTeamF] = useState("");
  const dragIdx = useRef(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ status: tab });
    if (teamF) p.set("team_id", teamF);
    apiFetch(`/issues?${p.toString()}`).then(setIssues).catch((e) => setError(e.message));
    apiFetch("/issues/stats").then(setStats).catch(() => setStats(null));
  }, [tab, teamF]);

  useEffect(() => {
    setIssues(null); load();
    apiFetch(`/teams${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setTeams).catch(() => {});
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {});
    apiFetch("/vcbs").then(setVcbs).catch(() => {});
  }, [activeTenantId, load]);

  // live-refresh when an item is created from the global Create drawer
  useEffect(() => {
    const h = () => load();
    window.addEventListener("hhcp:item-created", h);
    return () => window.removeEventListener("hhcp:item-created", h);
  }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  // Owner options follow the selected team.
  const ownerOptions = f.team_id ? teamMembers : people;
  async function pickTeam(team_id) {
    setF((s) => ({ ...s, team_id, owner_id: "" }));
    if (!team_id) { setTeamMembers([]); return; }
    try { setTeamMembers(await apiFetch(`/teams/${team_id}/members`)); }
    catch { setTeamMembers([]); }
  }

  async function createIssue(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/issues", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, priority: f.priority || null,
        category: f.category || null, team_id: f.team_id || null,
        owner_id: f.owner_id || null, vcb_id: f.vcb_id || null, description: f.description || null,
      })});
      setF(EMPTY); setOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function resolve(i) {
    const note = prompt(`Resolve “${i.title}” — add a resolution note:`, "");
    if (note === null) return;
    try { await apiFetch(`/issues/${i.id}`, { method: "PATCH", body: JSON.stringify({ status: "solved", resolution_note: note || null }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function reopen(i) {
    try { await apiFetch(`/issues/${i.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function delIssue(id) {
    if (!confirm("Delete this issue?")) return;
    try { await apiFetch(`/issues/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }
  async function makeTodo(i) {
    const title = prompt("Create a To-Do from this issue:", `Follow up: ${i.title}`);
    if (!title) return;
    try {
      await apiFetch("/todos", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title, source: "issue", issue_id: i.id,
        team_id: i.team_id || null, priority: i.priority || "medium",
      })});
      flash("To-Do created from issue — see the To-Dos module.");
    } catch (e) { setError(e.message); }
  }

  // ---- drag-and-drop priority ranking (open tab only) ----
  function onDrop(dropIdx) {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === dropIdx) return;
    const arr = [...issues];
    const [moved] = arr.splice(from, 1);
    arr.splice(dropIdx, 0, moved);
    setIssues(arr);  // optimistic
    apiFetch("/issues/reorder", { method: "POST", body: JSON.stringify({ order: arr.map((x) => x.id) }) })
      .catch((e) => { setError(e.message); load(); });
  }

  const draggable = tab === "open" && can("edit") && !teamF;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Issues</h1>
          <p className="page-sub">Identify, rank, own, and resolve — a simple Open → Resolved list.</p>
        </div>
        <div className="head-actions">
          {activeTenantId && issues && issues.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/issues.xlsx?tenant_id=${activeTenantId}`, "issues.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/issues.pdf?tenant_id=${activeTenantId}`, "issues.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="btn-secondary" onClick={() => setOpen(true)}>+ Create Issue</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <div className="filter-bar">
        <div className="seg">
          <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open{stats ? ` (${stats.open})` : ""}</button>
          <button className={tab === "solved" ? "on" : ""} onClick={() => setTab("solved")}>Resolved{stats ? ` (${stats.solved})` : ""}</button>
        </div>
        <select className="mini-input" value={teamF} onChange={(e) => setTeamF(e.target.value)}>
          <option value="">Company-wide</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {tab === "open" && draggable && <span className="drag-hint">↕ drag to rank priority</span>}
      </div>

      {stats && (stats.solved > 0 || stats.velocity.length > 0) && (
        <div className="card stats-card">
          <p className="mini-label">Resolution velocity {stats.avg_days_to_resolve != null ? `· avg ${stats.avg_days_to_resolve}d to resolve` : ""}</p>
          <div className="velocity-row">
            {stats.velocity.length === 0 && <span className="card-meta">No issues resolved in the last 8 weeks.</span>}
            {stats.velocity.map((v) => (
              <div className="velocity-bar-wrap" key={v.week} title={`Week of ${v.week}: ${v.resolved} resolved`}>
                <div className="velocity-bar" style={{ height: `${10 + v.resolved * 18}px` }} />
                <span className="velocity-label">{v.week.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!issues && !error && <p className="loading-line">Loading issues…</p>}
      {issues && issues.length === 0 && (
        <div className="empty-state"><p className="display">{tab === "open" ? "No open issues" : "No resolved issues"}</p><p>{tab === "open" ? "Nothing raised here yet — that’s a good sign." : "Resolved issues will be archived here with notes."}</p></div>
      )}

      {issues && issues.map((i, idx) => (
        <div
          className={`card issue-card ${draggable ? "draggable" : ""}`}
          key={i.id}
          draggable={draggable}
          onDragStart={() => (dragIdx.current = idx)}
          onDragOver={(e) => draggable && e.preventDefault()}
          onDrop={() => draggable && onDrop(idx)}
        >
          <div className="card-row">
            <div>
              <p className="card-title">
                {draggable && <span className="drag-grip">⠿</span>}
                {i.priority && <span className={`prio-pill ${i.priority}`}>{i.priority}</span>} {i.title}
                {i.category && <span className="freq-tag">{i.category}</span>}
                {i.vcb_title && <span className="freq-tag" title="Linked VCB">↑ {i.vcb_title}</span>}
              </p>
              {i.description && <p className="card-meta">{i.description}</p>}
              {i.status === "solved" && i.resolution_note && <p className="card-meta">✓ {i.resolution_note}</p>}
              <p className="card-meta">
                Owner: {i.owner_name || "Unassigned"}
                {" · "}Raised by {i.created_by_name || "system"}
                {i.team_name ? ` · Team: ${i.team_name}` : ""}
                {i.status === "solved" && i.solved_at ? ` · Resolved ${i.solved_at.slice(0, 10)}` : ""}
              </p>
            </div>
            <div className="card-controls">
              <span className={`badge ${i.status === "solved" ? "solved" : "open"}`}>{i.status === "solved" ? "resolved" : "open"}</span>
              {can("create") && i.status === "open" && <button className="btn-mini ghost" onClick={() => makeTodo(i)} title="Create a linked To-Do">→ To-Do</button>}
              {i.status === "open"
                ? <button className="btn-mini" onClick={() => resolve(i)}>Resolve</button>
                : <button className="btn-mini" onClick={() => reopen(i)}>Reopen</button>}
              {can("delete") && <button className="link-danger" onClick={() => delIssue(i.id)}>Delete</button>}
            </div>
          </div>
        </div>
      ))}

      <Modal open={open} onClose={() => setOpen(false)} accent="Issue" onSubmit={createIssue} submitDisabled={!f.title.trim()}>
        <label className="fld">Title<input value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a title for the Issue…" /></label>
        <div className="fld-row-3">
          <label className="fld">Priority <span className="fld-opt">(optional)</span>
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">Select…</option>
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </label>
          <label className="fld">Category <span className="fld-opt">(optional)</span>
            <input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Operations, Product…" />
          </label>
          <label className="fld">Owner {f.team_id ? <span className="fld-opt">(team members)</span> : null}
            <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
              <option value="">Unassigned</option>
              {ownerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <div className="fld-row-3">
          <label className="fld">Team
            <select value={f.team_id} onChange={(e) => pickTeam(e.target.value)}>
              <option value="">No team (company-level)</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="fld" style={{ gridColumn: "span 2" }}>Link to VCB <span className="fld-opt">(optional)</span>
            <select value={f.vcb_id} onChange={(e) => setF({ ...f, vcb_id: e.target.value })}>
              <option value="">Not linked</option>
              {vcbs.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
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
