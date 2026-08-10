"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";
import CreateDrawer from "@/components/CreateDrawer";

const EMPTY = { title: "", priority: "", category: "", team_id: "", owner_id: "", vcb_id: "", description: "" };
const initials = (n) => (n || "?").split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
const PRIOS = ["low", "medium", "high"];
const PRIO_LABEL = { low: "Low", medium: "Medium", high: "High" };

export default function IssuesPage() {
  const { activeTenantId, can } = useAuth();
  const [issues, setIssues] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);   // members of the team picked in the modal
  const [vcbs, setVcbs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [tab, setTab] = useState("short");       // 'short' | 'long' | 'solved'
  const [teamF, setTeamF] = useState("");
  const dragIdx = useRef(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (tab === "solved") p.set("status", "solved");
    else { p.set("status", "open"); p.set("term", tab); }   // short | long
    if (teamF) p.set("team_id", teamF);
    apiFetch(`/issues?${p.toString()}`).then(setIssues).catch((e) => setError(e.message));
  }, [tab, teamF]);

  useEffect(() => {
    setIssues(null); load();
    apiFetch(`/teams${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setTeams).catch(() => {});
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {});
    apiFetch("/vcbs").then(setVcbs).catch(() => {});
  }, [activeTenantId, load]);

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
  async function setPriority(i, priority) {
    try { await apiFetch(`/issues/${i.id}`, { method: "PATCH", body: JSON.stringify({ priority }) }); load(); }
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

  const draggable = tab !== "solved" && can("edit") && !teamF;
  const tabLabel = { short: "Short-Term", long: "Long-Term", solved: "Resolved" }[tab];

  return (
    <div className="mod-page">
      <div className="mod-head">
        <div>
          <h1 className="mod-title">Issues</h1>
          <p className="mod-sub">Identify and organize your team&rsquo;s most pressing Issues to resolve them with ease.</p>
        </div>
        <div className="mod-head-actions">
          {activeTenantId && issues && issues.length > 0 && (
            <>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/issues.xlsx?tenant_id=${activeTenantId}`, "issues.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/issues.pdf?tenant_id=${activeTenantId}`, "issues.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="mod-create" onClick={() => setCreateOpen(true)}>+ Create Issue</button>}
        </div>
      </div>

      <div className="mod-tabs">
        <button className={tab === "short" ? "active" : ""} onClick={() => setTab("short")}>Short-Term</button>
        <button className={tab === "long" ? "active" : ""} onClick={() => setTab("long")}>Long-Term</button>
        <button className={tab === "solved" ? "active" : ""} onClick={() => setTab("solved")}>Resolved</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <div className="mod-toolbar">
        <select className="mod-filter" value={teamF} onChange={(e) => setTeamF(e.target.value)}>
          <option value="">Team: Company-wide</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {draggable && <span className="drag-hint">↕ drag to rank priority</span>}
      </div>

      {!issues && !error && <p className="loading-line">Loading issues…</p>}
      {issues && issues.length === 0 && (
        <div className="empty-state"><p className="display">{tab === "solved" ? "No resolved issues" : `No ${tabLabel.toLowerCase()} issues`}</p><p>{tab === "solved" ? "Resolved issues will be archived here with notes." : "Nothing raised here yet — that’s a good sign."}</p></div>
      )}

      {issues && issues.length > 0 && (
        <div className="mod-list-card">
          <div className="mod-list-head"><h3>{tabLabel} <span className="rock-count">{issues.length}</span></h3></div>
          <div className="issue-table">
            <div className="issue-thead"><span></span><span></span><span>Title</span><span>Created</span><span>Owner</span><span></span></div>
            {issues.map((i, idx) => (
              <IssueRow
                key={i.id} i={i} idx={idx} tab={tab} draggable={draggable} dragIdx={dragIdx} onDrop={onDrop}
                canCreate={can("create")} canDelete={can("delete")} canEdit={can("edit")}
                setPriority={setPriority} resolve={resolve} reopen={reopen} makeTodo={makeTodo} delIssue={delIssue}
              />
            ))}
          </div>
        </div>
      )}

      <CreateDrawer open={createOpen} onClose={() => setCreateOpen(false)} initialType="issue" onCreated={() => load()} />

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

function IssueRow({ i, idx, tab, draggable, dragIdx, onDrop, canCreate, canDelete, canEdit, setPriority, resolve, reopen, makeTodo, delIssue }) {
  const [menu, setMenu] = useState(false);
  const solved = i.status === "solved";
  return (
    <div
      className={`issue-row ${draggable ? "draggable" : ""}`}
      draggable={draggable}
      onDragStart={() => (dragIdx.current = idx)}
      onDragOver={(e) => draggable && e.preventDefault()}
      onDrop={() => draggable && onDrop(idx)}
    >
      <div className="issue-cell issue-grip">{draggable ? "⠿" : ""}</div>
      <div className="issue-cell">
        <input type="checkbox" className="issue-check" checked={solved}
          title={solved ? "Reopen" : "Mark resolved"}
          onChange={() => (solved ? reopen(i) : resolve(i))} />
      </div>
      <div className="issue-cell issue-title-cell">
        <div className="issue-title-line">
          {tab === "open" && <span className="issue-num">{idx + 1}.</span>}
          {canEdit
            ? <PriorityPill value={i.priority} onChange={(p) => setPriority(i, p)} />
            : (i.priority && <span className={`prio-pill ${i.priority}`}>{i.priority}</span>)}
          <span className={`issue-title ${solved ? "struck" : ""}`}>{i.title}</span>
          {i.category && <span className="freq-tag">{i.category}</span>}
          {i.vcb_title && <span className="rock-vcb" title="Linked VCB">↑ {i.vcb_title}</span>}
        </div>
        {i.description && <span className="issue-desc">{i.description}</span>}
        {solved && i.resolution_note && <span className="issue-desc">✓ {i.resolution_note}</span>}
        <span className="issue-desc">Raised by {i.created_by_name || "system"}{i.team_name ? ` · ${i.team_name}` : ""}{solved && i.solved_at ? ` · resolved ${i.solved_at.slice(0, 10)}` : ""}</span>
      </div>
      <div className="issue-cell issue-created">{i.created_at ? i.created_at.slice(0, 10) : "—"}</div>
      <div className="issue-cell"><span className="owner-bubble" title={i.owner_name || "Unassigned"}>{initials(i.owner_name)}</span></div>
      <div className="issue-cell issue-kebab-cell">
        {(canCreate || canDelete) && (
          <span className="status-pill-wrap">
            <button type="button" className="issue-kebab" title="More" onClick={() => setMenu((o) => !o)}>⋯</button>
            {menu && (
              <>
                <div className="status-menu-back" onClick={() => setMenu(false)} />
                <div className="status-menu right">
                  {canCreate && !solved && <button type="button" onClick={() => { setMenu(false); makeTodo(i); }}>→ Create To-Do</button>}
                  <button type="button" onClick={() => { setMenu(false); (solved ? reopen(i) : resolve(i)); }}>{solved ? "Reopen issue" : "Resolve issue"}</button>
                  {canDelete && <button type="button" className="danger" onClick={() => { setMenu(false); delIssue(i.id); }}>Delete</button>}
                </div>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function PriorityPill({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="status-pill-wrap">
      <button type="button" className={`prio-pill ${value || "none"} prio-btn`} onClick={() => setOpen((o) => !o)}>
        {value || "priority"}
        <svg className="status-caret" width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <>
          <div className="status-menu-back" onClick={() => setOpen(false)} />
          <div className="status-menu">
            {PRIOS.map((p) => (
              <button key={p} type="button" className={p === value ? "sel" : ""} onClick={() => { onChange(p); setOpen(false); }}>
                <span className={`prio-dot ${p}`} />{PRIO_LABEL[p]}{p === value && <span className="status-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
