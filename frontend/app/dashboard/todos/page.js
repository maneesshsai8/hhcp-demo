"use client";
import { useEffect, useState, useCallback } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";
import CreateDrawer from "@/components/CreateDrawer";

const EMPTY = { title: "", due_date: "", team_id: "", owner_id: "", priority: "medium", is_private: false, description: "", vcb_id: "" };
const PRIOS = ["low", "medium", "high"];
const PRIO_LABEL = { low: "Low", medium: "Medium", high: "High" };
const initials = (n) => (n || "?").split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();

export default function TodosPage() {
  const { activeTenantId, can } = useAuth();
  const [todos, setTodos] = useState(null);
  const [stats, setStats] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);   // members of the team picked in the modal
  const [vcbs, setVcbs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [f, setF] = useState(EMPTY);

  // view + filters
  const [mine, setMine] = useState(false);
  const [win, setWin] = useState("all");          // 'all' | '7' | '90'
  const [statusF, setStatusF] = useState("all");  // 'all' | 'open' | 'done'
  const [ownerF, setOwnerF] = useState("");
  const [teamF, setTeamF] = useState("");

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (mine) p.set("mine", "true");
    if (win !== "all") p.set("window", win);
    if (statusF !== "all") p.set("status", statusF);
    if (ownerF) p.set("owner_id", ownerF);
    if (teamF) p.set("team_id", teamF);
    apiFetch(`/todos?${p.toString()}`).then(setTodos).catch((e) => setError(e.message));
    apiFetch("/todos/stats").then(setStats).catch(() => setStats(null));
  }, [mine, win, statusF, ownerF, teamF]);

  useEffect(() => {
    setTodos(null); load();
    apiFetch(`/teams${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setTeams).catch(() => {});
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {});
    apiFetch("/vcbs").then(setVcbs).catch(() => {});
  }, [activeTenantId, load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  async function createTodo(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/todos", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, due_date: f.due_date || null,
        team_id: f.team_id || null, owner_id: f.owner_id || null, priority: f.priority,
        is_private: f.is_private, description: f.description || null, vcb_id: f.vcb_id || null,
      })});
      setF(EMPTY); setOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  // Owner options follow the selected team: pick a team → only its members.
  const ownerOptions = f.team_id ? teamMembers : people;
  async function pickTeam(team_id) {
    setF((s) => ({ ...s, team_id, owner_id: "" }));
    if (!team_id) { setTeamMembers([]); return; }
    try { setTeamMembers(await apiFetch(`/teams/${team_id}/members`)); }
    catch { setTeamMembers([]); }
  }

  async function toggleDone(t) {
    if (t.status === "open") {
      const note = prompt(`Mark “${t.title}” complete — add an optional completion note:`, "");
      if (note === null) return; // cancelled
      try { await apiFetch(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "done", completion_note: note || null }) }); load(); }
      catch (e) { setError(e.message); }
    } else {
      try { await apiFetch(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }); load(); }
      catch (e) { setError(e.message); }
    }
  }
  async function setPriority(t, priority) {
    try { await apiFetch(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ priority }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm("Delete this To-Do?")) return;
    try { await apiFetch(`/todos/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }
  async function carryForward() {
    try { const r = await apiFetch(`/todos/carry-forward?tenant_id=${activeTenantId}`, { method: "POST" });
      flash(`Carried ${r.carried} overdue to-do(s) forward to next week's review.`); load(); }
    catch (e) { setError(e.message); }
  }

  const overdueCount = (todos || []).filter((t) => t.is_overdue).length;

  return (
    <div className="mod-page">
      <div className="mod-head">
        <div>
          <h1 className="mod-title">To-Dos</h1>
          <p className="mod-sub">Create, assign, and track deadlines for critical tasks.</p>
        </div>
        <div className="mod-head-actions">
          {activeTenantId && can("edit") && <button className="mod-ghost" onClick={carryForward} title="Flag overdue items for next week">↻ Carry forward</button>}
          {activeTenantId && todos && todos.length > 0 && (
            <>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/todos.xlsx?tenant_id=${activeTenantId}`, "todos.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/todos.pdf?tenant_id=${activeTenantId}`, "todos.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="mod-create" onClick={() => setCreateOpen(true)}>+ Create To-Do</button>}
        </div>
      </div>

      <div className="mod-tabs">
        <button className={!mine ? "active" : ""} onClick={() => setMine(false)}>All To-Dos</button>
        <button className={mine ? "active" : ""} onClick={() => setMine(true)}>My To-Dos</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}
      {overdueCount > 0 && <div className="error-banner soft">⚠ {overdueCount} overdue to-do{overdueCount > 1 ? "s" : ""} need attention.</div>}

      <div className="mod-toolbar">
        <select className="mod-filter" value={win} onChange={(e) => setWin(e.target.value)}>
          <option value="all">Due: All</option><option value="7">Due: Next 7 days</option><option value="90">Due: Next 90 days</option>
        </select>
        <select className="mod-filter" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">Status: All</option><option value="open">Open</option><option value="done">Done</option>
        </select>
        <select className="mod-filter" value={ownerF} onChange={(e) => setOwnerF(e.target.value)}>
          <option value="">Owner: All</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="mod-filter" value={teamF} onChange={(e) => setTeamF(e.target.value)}>
          <option value="">Team: All</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      {stats && stats.by_owner.length > 0 && (
        <div className="mod-list-card stats-card">
          <p className="mini-label">Completion rate</p>
          <div className="stats-grid">
            {stats.by_owner.map((s) => (
              <div className="stat-cell" key={"o" + s.name}>
                <span className="stat-name">{s.name}</span>
                <span className="progress-track sm"><span className="progress-fill" style={{ width: `${s.completion_rate}%` }} /></span>
                <span className="stat-num">{s.completion_rate}% · {s.done}/{s.total}{s.overdue ? ` · ${s.overdue} overdue` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!todos && !error && <p className="loading-line">Loading to-dos…</p>}
      {todos && todos.length === 0 && (
        <div className="empty-state"><p className="display">No To-Dos here</p><p>Nothing matches these filters.</p></div>
      )}

      {todos && todos.length > 0 && (
        <div className="mod-list-card">
          <div className="mod-list-head"><h3>{mine ? "My To-Dos" : "Team To-Dos"} <span className="rock-count">{todos.length}</span></h3></div>
          <div className="todo-table">
            <div className="todo-thead"><span></span><span>Title</span><span>Due By</span><span>Owner</span><span></span></div>
            {todos.map((t) => (
              <TodoRow key={t.id} t={t} canEdit={can("edit")} canDelete={can("delete")}
                toggleDone={toggleDone} setPriority={setPriority} del={del} />
            ))}
          </div>
        </div>
      )}

      <CreateDrawer open={createOpen} onClose={() => setCreateOpen(false)} initialType="todo" onCreated={() => load()} />

      <Modal open={open} onClose={() => setOpen(false)} accent="To-Do" onSubmit={createTodo} submitDisabled={!f.title.trim()}>
        <label className="fld">Title<input value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a title for the To-Do…" /></label>
        <div className="fld-row-3">
          <label className="fld">Due date<input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></label>
          <label className="fld">Priority
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {PRIOS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </label>
          <label className="fld">Owner {f.team_id ? <span className="fld-opt">(team members)</span> : null}
            <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
              <option value="">{f.team_id ? "Unassigned" : "You"}</option>
              {ownerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <div className="fld-row-3">
          <label className="fld">Team
            <select value={f.team_id} onChange={(e) => pickTeam(e.target.value)}>
              <option value="">No team</option>
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
        <label className="fld-check">
          <input type="checkbox" checked={f.is_private} onChange={(e) => setF({ ...f, is_private: e.target.checked })} />
          Make this To-Do private
        </label>
        <label className="fld">Description <span className="fld-opt">(optional)</span>
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Add a description…" />
        </label>
      </Modal>
    </div>
  );
}

function PriorityPill({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="status-pill-wrap">
      <button type="button" className={`prio-pill ${value} prio-btn`} onClick={() => setOpen((o) => !o)}>
        {value}
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

function TodoRow({ t, canEdit, canDelete, toggleDone, setPriority, del }) {
  const done = t.status === "done";
  const meta = [];
  if (t.source && t.source !== "manual") meta.push(`from ${t.source}`);
  if (t.issue_title) meta.push(`issue: ${t.issue_title}`);
  return (
    <div className={`todo-row ${t.is_overdue ? "overdue" : ""} ${done ? "is-done" : ""}`}>
      <div className="todo-cell"><input type="checkbox" className="todo-check" checked={done} onChange={() => toggleDone(t)} /></div>
      <div className="todo-cell todo-title-cell">
        <div className="todo-title-line">
          {canEdit ? <PriorityPill value={t.priority} onChange={(p) => setPriority(t, p)} /> : <span className={`prio-pill ${t.priority}`}>{t.priority}</span>}
          <span className={`todo-title ${done ? "struck" : ""}`}>{t.title}</span>
          {t.is_private && <span className="todo-lock" title="Private">🔒</span>}
          {t.is_overdue && <span className="overdue-tag">OVERDUE</span>}
          {t.carried_count > 0 && <span className="freq-tag" title="Carried forward from previous weeks">↻ ×{t.carried_count}</span>}
          {t.vcb_title && <span className="rock-vcb" title={t.vcb_title}>↑ {t.vcb_title}</span>}
        </div>
        {t.description && <span className="todo-desc">{t.description}</span>}
        {t.completion_note && done && <span className="todo-desc">✓ {t.completion_note}</span>}
        {meta.length > 0 && <span className="todo-desc">{meta.join(" · ")}</span>}
      </div>
      <div className="todo-cell todo-due">{t.due_date || "—"}</div>
      <div className="todo-cell"><span className="owner-bubble" title={t.owner_name || "Unassigned"}>{initials(t.owner_name)}</span></div>
      <div className="todo-cell todo-actions">{canDelete && <button title="Delete" onClick={() => del(t.id)}>🗑</button>}</div>
    </div>
  );
}
