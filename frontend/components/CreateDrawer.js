"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

/*
 Unified "Create" drawer opened from a module's Create button. A type switcher
 (Create Measurable ▾ → Rock / To-Do / Issue) shows the matching form and posts
 to that module's endpoint. Owner/assignee options use the /directory + team
 members (id = user id), so no FK issues. Broadcasts nothing; caller refreshes
 via onCreated.
*/
const TYPES = [
  { key: "measurable", label: "Measurable" },
  { key: "rock", label: "Rock" },
  { key: "todo", label: "To-Do" },
  { key: "issue", label: "Issue" },
];

export default function CreateDrawer({ open, onClose, initialType = "measurable", initialTitle = "", onCreated, tenantId, initialWorkstreamId }) {
  const { activeTenantId, accessibleTenants } = useAuth();
  const baseTenant = tenantId || activeTenantId;   // forced tenant (e.g. a meeting) wins
  const [type, setType] = useState(initialType);
  const [typeMenu, setTypeMenu] = useState(false);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [vcbs, setVcbs] = useState([]);
  const [f, setF] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setType(initialType); setF({ tenant_id: baseTenant || "", workstream_id: initialWorkstreamId || "", title: initialTitle || "" }); setErr(""); setTypeMenu(false); setTeamMembers([]); }
  }, [open, initialType, initialTitle, baseTenant, initialWorkstreamId]);

  const tid = f.tenant_id || baseTenant;
  useEffect(() => {
    if (!open || !tid) return;
    apiFetch(`/teams?tenant_id=${tid}`).then(setTeams).catch(() => setTeams([]));
    apiFetch(`/directory?tenant_id=${tid}`).then(setPeople).catch(() => setPeople([]));
    apiFetch("/vcbs").then(setVcbs).catch(() => setVcbs([]));
  }, [open, tid]);

  if (!open) return null;

  const up = (patch) => setF((s) => ({ ...s, ...patch }));
  const ownerOptions = f.team_id ? teamMembers : people;
  const wsOptions = vcbs.flatMap((v) => (v.workstreams || []).map((w) => ({ id: w.id, label: `${v.title} › ${w.name}` })));
  const label = TYPES.find((t) => t.key === type)?.label;
  const pickable = (accessibleTenants || []).filter((t) => t.tenant_type !== "fund");
  const hasGoal = f.target_value !== undefined && f.target_value !== null && String(f.target_value) !== "";
  const canSubmit = !!tid && !!(f.title || "").trim() && !busy && (type !== "measurable" || hasGoal);

  async function pickTeam(team_id) {
    up({ team_id, owner_id: "" });
    if (!team_id) { setTeamMembers([]); return; }
    try { setTeamMembers(await apiFetch(`/teams/${team_id}/members`)); } catch { setTeamMembers([]); }
  }

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      if (type === "measurable") {
        const goal = Number(f.target_value || 0);
        await apiFetch("/scorecards", { method: "POST", body: JSON.stringify({
          tenant_id: tid, title: f.title, target_value: goal,
          green_threshold: f.green_threshold !== undefined && f.green_threshold !== "" ? Number(f.green_threshold) : goal,
          red_threshold: f.red_threshold !== undefined && f.red_threshold !== "" ? Number(f.red_threshold) : goal,
          direction: f.direction || "higher_is_better", frequency: f.frequency || "weekly",
          unit: f.unit || "units", owner_id: f.owner_id || null,
        })});
      } else if (type === "rock") {
        await apiFetch("/rocks", { method: "POST", body: JSON.stringify({
          tenant_id: tid, title: f.title, status: f.status || "on_track", due_date: f.due_date || null,
          team_id: f.team_id || null, assignee_ids: f.owner_id ? [f.owner_id] : null,
          description: f.description || null, workstream_id: f.workstream_id || null,
        })});
      } else if (type === "todo") {
        await apiFetch("/todos", { method: "POST", body: JSON.stringify({
          tenant_id: tid, title: f.title, due_date: f.due_date || null, team_id: f.team_id || null,
          owner_id: f.owner_id || null, priority: f.priority || "medium", is_private: !!f.is_private,
          description: f.description || null, vcb_id: f.vcb_id || null,
        })});
      } else {
        await apiFetch("/issues", { method: "POST", body: JSON.stringify({
          tenant_id: tid, title: f.title, priority: f.priority || null, category: f.category || null,
          team_id: f.team_id || null, owner_id: f.owner_id || null, vcb_id: f.vcb_id || null,
          description: f.description || null, term: f.term || "short",
        })});
      }
      onCreated?.(type);
      onClose(type);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const teamOwnerFields = (
    <div className="drawer-two">
      <label className="drawer-field">Team
        <select value={f.team_id || ""} onChange={(e) => pickTeam(e.target.value)}>
          <option value="">No team</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="drawer-field">Owner
        <select value={f.owner_id || ""} onChange={(e) => up({ owner_id: e.target.value })}>
          <option value="">Unassigned</option>
          {ownerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );

  return (
    <div className="score-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="score-drawer create-drawer">
        <div className="score-drawer-head">
          <h2 className="create-title">
            Create{" "}
            <span className="create-type-wrap">
              <button type="button" className="create-type" onClick={() => setTypeMenu((o) => !o)}>
                <span className="create-type-label">{label}</span> <span className={`cd-caret ${typeMenu ? "up" : ""}`}>⌄</span>
              </button>
              {typeMenu && (
                <div className="create-type-menu" onMouseLeave={() => setTypeMenu(false)}>
                  {TYPES.map((t) => (
                    <button key={t.key} type="button" className={t.key === type ? "sel" : ""}
                      onClick={() => { setType(t.key); setTypeMenu(false); }}>{t.label}</button>
                  ))}
                </div>
              )}
            </span>
          </h2>
          <button className="drawer-x" type="button" onClick={() => onClose()}>×</button>
        </div>

        {!baseTenant && (
          <label className="drawer-field">Workspace
            <select value={f.tenant_id || ""} onChange={(e) => up({ tenant_id: e.target.value, team_id: "", owner_id: "" })} required>
              <option value="">Select a workspace…</option>
              {pickable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}

        <form onSubmit={submit}>
          <label className="drawer-field">Title
            <input value={f.title || ""} onChange={(e) => up({ title: e.target.value })} placeholder={`Add a title for the ${label}…`} required autoFocus />
          </label>

          {type === "measurable" && (
            <>
              <label className="drawer-field">Owner
                <select value={f.owner_id || ""} onChange={(e) => up({ owner_id: e.target.value })}>
                  <option value="">Unassigned</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <div className="drawer-two">
                <label className="drawer-field">Goal<input type="number" step="any" value={f.target_value ?? ""} onChange={(e) => up({ target_value: e.target.value })} required /></label>
                <label className="drawer-field">Unit<input value={f.unit || ""} onChange={(e) => up({ unit: e.target.value })} placeholder="units, $, %" /></label>
              </div>
              <div className="drawer-two">
                <label className="drawer-field">Direction
                  <select value={f.direction || "higher_is_better"} onChange={(e) => up({ direction: e.target.value })}>
                    <option value="higher_is_better">Higher is better</option>
                    <option value="lower_is_better">Lower is better</option>
                  </select>
                </label>
                <label className="drawer-field">Frequency
                  <select value={f.frequency || "weekly"} onChange={(e) => up({ frequency: e.target.value })}>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
              </div>
            </>
          )}

          {type === "rock" && (
            <>
              {teamOwnerFields}
              <div className="drawer-two">
                <label className="drawer-field">Due date<input type="date" value={f.due_date || ""} onChange={(e) => up({ due_date: e.target.value })} /></label>
                <label className="drawer-field">Status
                  <select value={f.status || "on_track"} onChange={(e) => up({ status: e.target.value })}>
                    <option value="on_track">On-track</option><option value="off_track">Off-track</option><option value="complete">Complete</option>
                  </select>
                </label>
              </div>
              <label className="drawer-field">Ladders up to <span>(VCB › Workstream)</span>
                <select value={f.workstream_id || ""} onChange={(e) => up({ workstream_id: e.target.value })}>
                  <option value="">None</option>
                  {wsOptions.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </label>
            </>
          )}

          {type === "todo" && (
            <>
              {teamOwnerFields}
              <div className="drawer-two">
                <label className="drawer-field">Due date<input type="date" value={f.due_date || ""} onChange={(e) => up({ due_date: e.target.value })} /></label>
                <label className="drawer-field">Priority
                  <select value={f.priority || "medium"} onChange={(e) => up({ priority: e.target.value })}>
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </label>
              </div>
              <label className="drawer-toggle-row"><input type="checkbox" checked={!!f.is_private} onChange={(e) => up({ is_private: e.target.checked })} /> Make this To-Do private</label>
            </>
          )}

          {type === "issue" && (
            <>
              {teamOwnerFields}
              <div className="drawer-two">
                <label className="drawer-field">Interval
                  <select value={f.term || "short"} onChange={(e) => up({ term: e.target.value })}>
                    <option value="short">Short-Term</option>
                    <option value="long">Long-Term</option>
                  </select>
                </label>
                <label className="drawer-field">Priority
                  <select value={f.priority || ""} onChange={(e) => up({ priority: e.target.value })}>
                    <option value="">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </label>
              </div>
              <label className="drawer-field">Category<input value={f.category || ""} onChange={(e) => up({ category: e.target.value })} placeholder="e.g. People, Process" /></label>
            </>
          )}

          {(type === "todo" || type === "issue") && (
            <label className="drawer-field">Link to VCB <span>(Optional)</span>
              <select value={f.vcb_id || ""} onChange={(e) => up({ vcb_id: e.target.value })}>
                <option value="">None</option>
                {vcbs.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
            </label>
          )}

          {type !== "measurable" && (
            <label className="drawer-field">Description <span>(Optional)</span>
              <textarea value={f.description || ""} onChange={(e) => up({ description: e.target.value })} placeholder="Add a description" />
            </label>
          )}

          {err && <p className="drawer-err">{err}</p>}

          <div className="score-drawer-footer">
            <button className="score-save" type="submit" disabled={!canSubmit}>{busy ? "Creating…" : `Create ${label}`}</button>
            <button className="score-cancel" type="button" onClick={() => onClose()}>Cancel</button>
          </div>
        </form>
      </aside>
    </div>
  );
}
