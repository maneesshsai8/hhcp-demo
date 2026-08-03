"use client";
import { useEffect, useState } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";

const EMPTY = { title: "", due_date: "", team_id: "", owner_id: "", is_private: false, description: "" };

export default function TodosPage() {
  const { activeTenantId, can } = useAuth();
  const [todos, setTodos] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);

  function load() {
    apiFetch("/todos").then(setTodos).catch((e) => setError(e.message));
    apiFetch("/teams").then(setTeams).catch(() => {});
    apiFetch("/directory").then(setPeople).catch(() => {});
  }
  useEffect(() => { setTodos(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function createTodo(e) {
    e.preventDefault();
    if (!f.title.trim() || !activeTenantId) return;
    try {
      await apiFetch("/todos", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, due_date: f.due_date || null,
        team_id: f.team_id || null, owner_id: f.owner_id || null,
        is_private: f.is_private, description: f.description || null,
      })});
      setF(EMPTY); setOpen(false); load();
    } catch (e) { setError(e.message); }
  }
  async function toggleDone(t) {
    try { await apiFetch(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: t.status === "open" ? "done" : "open" }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm("Delete this To-Do?")) return;
    try { await apiFetch(`/todos/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">To-Dos</h1>
          <p className="page-sub">Create, assign, and track deadlines for critical tasks.</p>
        </div>
        <div className="head-actions">
          {activeTenantId && todos && todos.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/todos.xlsx?tenant_id=${activeTenantId}`, "todos.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/todos.pdf?tenant_id=${activeTenantId}`, "todos.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="btn-secondary" onClick={() => setOpen(true)}>+ Create To-Do</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!todos && !error && <p className="loading-line">Loading to-dos…</p>}
      {todos && todos.length === 0 && (
        <div className="empty-state"><p className="display">No To-Dos yet</p><p>Add a task with a deadline above.</p></div>
      )}

      {todos && todos.map((t) => (
        <div className="card" key={t.id}>
          <div className="card-row">
            <div className="todo-main">
              <input type="checkbox" className="todo-check" checked={t.status === "done"} onChange={() => toggleDone(t)} />
              <div>
                <p className={`card-title ${t.status === "done" ? "struck" : ""}`}>{t.title}{t.is_private ? " 🔒" : ""}</p>
                {t.description && <p className="card-meta">{t.description}</p>}
                <p className="card-meta">
                  Owner: {t.owner_name || "Unassigned"}
                  {t.team_name ? ` · Team: ${t.team_name}` : ""}
                  {t.due_date ? ` · Due ${t.due_date}` : ""}
                </p>
              </div>
            </div>
            {can("delete") && <button className="link-danger" onClick={() => del(t.id)}>Delete</button>}
          </div>
        </div>
      ))}

      <Modal open={open} onClose={() => setOpen(false)} accent="To-Do" onSubmit={createTodo} submitDisabled={!f.title.trim()}>
        <label className="fld">Title<input value={f.title} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a title for the To-Do…" /></label>
        <div className="fld-row-3">
          <label className="fld">Due date<input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></label>
          <label className="fld">Team
            <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}>
              <option value="">No team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="fld">Owner
            <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
              <option value="">You</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
