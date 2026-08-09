"use client";
import { useEffect, useState } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import Modal from "@/components/Modal";
import MultiSelect from "@/components/MultiSelect";
import VcbsPage from "@/app/dashboard/vcbs/page";
import CreateDrawer from "@/components/CreateDrawer";

const EMPTY = { title: "", due_date: "", status: "on_track", team_id: "", assignee_ids: [], description: "", workstream_id: "" };

const STATUS_META = {
  on_track: { label: "On-track", cls: "on" },
  off_track: { label: "Off-track", cls: "off" },
  complete: { label: "Complete", cls: "done" },
};
const initials = (n) => (n || "?").split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
const progressFor = (s) => (s === "complete" ? 100 : s === "on_track" ? 60 : 20);
const ROCK_TABS = [["list", "List"], ["board", "Planning Board"], ["blueprints", "Blueprints"], ["archive", "Archive"]];

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
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState("list");         // list | board | blueprints | archive
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [ownerF, setOwnerF] = useState("all");

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

  const list = rocks || [];
  const ownerNames = Array.from(new Set(list.map((r) => r.owner_name).filter(Boolean)));
  const matches = (r) =>
    (statusF === "all" || r.status === statusF) &&
    (ownerF === "all" || r.owner_name === ownerF) &&
    (!q.trim() || String(r.title).toLowerCase().includes(q.trim().toLowerCase()));
  const filtered = list.filter(matches);
  // List view: group by owner (unowned → "Company Rocks", shown first)
  const groups = {};
  filtered.forEach((r) => { const k = r.owner_name || "Company Rocks"; (groups[k] = groups[k] || []).push(r); });
  const groupKeys = Object.keys(groups).sort((a, b) => (a === "Company Rocks" ? -1 : b === "Company Rocks" ? 1 : a.localeCompare(b)));
  const archived = filtered.filter((r) => r.status === "complete");

  const rowProps = { canDelete: can("delete"), setStatus, delRock };

  return (
    <div className="mod-page">
      <div className="mod-head">
        <div>
          <h1 className="mod-title">Rocks</h1>
          <p className="mod-sub">Set and track quarterly goals to help your team consistently hit their targets.</p>
        </div>
        <div className="mod-head-actions">
          {activeTenantId && list.length > 0 && (
            <>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/rocks.xlsx?tenant_id=${activeTenantId}`, "rocks.xlsx").catch((e) => setError(e.message))}>Export Excel</button>
              <button className="mod-ghost" onClick={() => apiDownload(`/reports/rocks.pdf?tenant_id=${activeTenantId}`, "rocks.pdf").catch((e) => setError(e.message))}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && <button className="mod-create" onClick={() => setCreateOpen(true)}>+ Create Rock</button>}
        </div>
      </div>

      <div className="mod-tabs">
        {ROCK_TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {tab === "blueprints" ? (
        <div className="mod-embed"><VcbsPage /></div>
      ) : (
        <>
          <div className="mod-toolbar">
            <select className="mod-filter" value={ownerF} onChange={(e) => setOwnerF(e.target.value)}>
              <option value="all">Owner: All</option>
              {ownerNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select className="mod-filter" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="all">Status: All</option>
              <option value="on_track">On-track</option>
              <option value="off_track">Off-track</option>
              <option value="complete">Complete</option>
            </select>
            <label className="mod-search"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Rocks…" /></label>
          </div>

          {!rocks && !error && <p className="loading-line">Loading rocks…</p>}
          {rocks && list.length === 0 && (
            <div className="empty-state"><p className="display">No Rocks set yet</p><p>Create this tenant&rsquo;s top priorities.</p></div>
          )}

          {tab === "list" && rocks && list.length > 0 && (
            <div className="rock-groups">
              {groupKeys.map((k) => (
                <div className="rock-group" key={k}>
                  <div className="rock-group-head">
                    <span className="owner-bubble lg">{k === "Company Rocks" ? "★" : initials(k)}</span>
                    <h3>{k}</h3><span className="rock-count">{groups[k].length}</span>
                  </div>
                  <div className="rock-table">
                    <div className="rock-thead"><span>Status</span><span>Title</span><span>Milestone progress</span><span>Owner</span><span>Due by</span><span></span></div>
                    {groups[k].map((r) => <RockRow key={r.id} r={r} {...rowProps} />)}
                  </div>
                </div>
              ))}
              {filtered.length === 0 && <div className="empty-state"><p>No Rocks match these filters.</p></div>}
            </div>
          )}

          {tab === "board" && rocks && (
            <div className="rock-board">
              {["on_track", "off_track", "complete"].map((s) => {
                const col = filtered.filter((r) => r.status === s);
                return (
                  <div className="rock-col" key={s}>
                    <div className="rock-col-head"><span className={`rock-dot ${STATUS_META[s].cls}`} />{STATUS_META[s].label}<span className="rock-count">{col.length}</span></div>
                    {col.map((r) => (
                      <div className="rock-card" key={r.id}>
                        <p className="rock-card-title">{r.title}</p>
                        {r.workstream_name && <span className="rock-vcb" title={`${r.vcb_title} › ${r.workstream_name}`}>↑ {r.vcb_title}</span>}
                        <div className="rock-card-foot">
                          <span className="owner-bubble" title={r.owner_name || "Unassigned"}>{initials(r.owner_name)}</span>
                          <span className="rock-card-due">{r.due_date || "—"}</span>
                        </div>
                      </div>
                    ))}
                    {col.length === 0 && <p className="rock-col-empty">No Rocks</p>}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "archive" && rocks && (
            <div className="rock-group">
              <div className="rock-group-head"><h3>Completed Rocks</h3><span className="rock-count">{archived.length}</span></div>
              <div className="rock-table">
                <div className="rock-thead"><span>Status</span><span>Title</span><span>Milestone progress</span><span>Owner</span><span>Due by</span><span></span></div>
                {archived.map((r) => <RockRow key={r.id} r={r} {...rowProps} />)}
              </div>
              {archived.length === 0 && <div className="empty-state"><p>No completed Rocks yet.</p></div>}
            </div>
          )}
        </>
      )}

      <CreateDrawer open={createOpen} onClose={() => setCreateOpen(false)} initialType="rock" onCreated={() => load()} />

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

function RockRow({ r, canDelete, setStatus, delRock }) {
  const sm = STATUS_META[r.status] || STATUS_META.on_track;
  return (
    <div className="rock-row">
      <div className="rock-cell">
        <StatusPill value={r.status} onChange={(v) => setStatus(r.id, v)} />
      </div>
      <div className="rock-cell rock-title-cell">
        <span className="rock-title">{r.title}</span>
        {r.workstream_name && <span className="rock-vcb" title={`${r.vcb_title} › ${r.workstream_name}`}>↑ {r.vcb_title}</span>}
        {r.description && <span className="rock-desc">{r.description}</span>}
      </div>
      <div className="rock-cell">
        <div className="rock-progress-track" title={sm.label}><span style={{ width: `${progressFor(r.status)}%` }} /></div>
      </div>
      <div className="rock-cell"><span className="owner-bubble" title={r.owner_name || "Unassigned"}>{initials(r.owner_name)}</span></div>
      <div className="rock-cell rock-due">{r.due_date || "—"}</div>
      <div className="rock-cell rock-row-actions">{canDelete && <button title="Delete" onClick={() => delRock(r.id)}>🗑</button>}</div>
    </div>
  );
}

function StatusPill({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const sm = STATUS_META[value] || STATUS_META.on_track;
  return (
    <div className="status-pill-wrap">
      <button type="button" className={`status-pill ${sm.cls}`} onClick={() => setOpen((o) => !o)}>
        <span className="status-dot" />
        <span className="status-label">{sm.label}</span>
        <svg className="status-caret" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <>
          <div className="status-menu-back" onClick={() => setOpen(false)} />
          <div className="status-menu">
            {Object.entries(STATUS_META).map(([k, m]) => (
              <button key={k} type="button" className={`${m.cls} ${k === value ? "sel" : ""}`}
                onClick={() => { onChange(k); setOpen(false); }}>
                <span className="status-dot" />{m.label}
                {k === value && <span className="status-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
