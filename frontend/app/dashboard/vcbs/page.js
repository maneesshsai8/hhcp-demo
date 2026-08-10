"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import CreateDrawer from "@/components/CreateDrawer";

const THESES = ["Margin expansion", "Geographic expansion", "Tuck-in M&A", "Digital transformation", "Operational excellence"];
const STATUS_LABEL = { on_track: "On-Track", off_track: "Off-Track", complete: "Complete" };
const ROCK_STATUS = ["on_track", "off_track", "complete"];
const LEADERSHIP = new Set(["fund_admin", "lead_partner", "deal_qb", "portco_management"]);

const BLANK = { title: "", description: "", investment_thesis: THESES[0], outcome: "", start_date: "", end_date: "", workstreams: ["", "", ""] };

export default function VcbsPage() {
  const { activeTenantId, activeRole } = useAuth();
  const [vcbs, setVcbs] = useState(null);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nv, setNv] = useState(BLANK);
  const [openId, setOpenId] = useState(null);        // drill-down VCB
  const [showArchived, setShowArchived] = useState(false);
  const [people, setPeople] = useState([]);
  const [wsDraft, setWsDraft] = useState({});         // vcb_id -> new workstream name
  const [createRockWs, setCreateRockWs] = useState(null); // {tenantId, workstreamId} → open Create Rock

  const isLeader = LEADERSHIP.has(activeRole) || !activeTenantId; // admin rollup counts as leader

  function load() {
    const q = showArchived ? "?include_archived=true" : "";
    apiFetch(`/vcbs${q}`).then(setVcbs).catch((e) => setError(e.message));
  }
  useEffect(() => { setVcbs(null); load(); apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {}); /* eslint-disable-next-line */ }, [activeTenantId, showArchived]);

  async function createVcb(e) {
    e.preventDefault();
    if (!activeTenantId || !nv.title.trim()) return;
    try {
      await apiFetch("/vcbs", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: nv.title, description: nv.description || null,
        investment_thesis: nv.investment_thesis, outcome: nv.outcome || null,
        start_date: nv.start_date || null, end_date: nv.end_date || null,
        workstreams: nv.workstreams.filter((w) => w.trim()),
      })});
      setNv(BLANK); setShowNew(false); load();
    } catch (e) { setError(e.message); }
  }

  async function setVcbStatus(id, status) {
    try { await apiFetch(`/vcbs/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function archiveVcb(id) {
    try { await apiFetch(`/vcbs/${id}`, { method: "PATCH", body: JSON.stringify({ archived: true, status: "complete" }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function delVcb(id) {
    if (!confirm("Delete this VCB, its workstreams, and unlink its Rocks?")) return;
    try { await apiFetch(`/vcbs/${id}`, { method: "DELETE" }); setOpenId(null); load(); }
    catch (e) { setError(e.message); }
  }
  async function addWorkstream(vcbId) {
    const name = (wsDraft[vcbId] || "").trim();
    if (!name) return;
    try { await apiFetch(`/vcbs/${vcbId}/workstreams`, { method: "POST", body: JSON.stringify({ name }) });
      setWsDraft({ ...wsDraft, [vcbId]: "" }); load(); } catch (e) { setError(e.message); }
  }
  async function renameWorkstream(id, name) {
    try { await apiFetch(`/vcbs/workstreams/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function delWorkstream(id) {
    try { await apiFetch(`/vcbs/workstreams/${id}`, { method: "DELETE" }); load(); }
    catch (e) { setError(e.message); }
  }
  // inline Rock edits from the grid
  async function patchRock(id, patch) {
    try { await apiFetch(`/rocks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function addRock(vcbTenant, wsId, title) {
    if (!title.trim()) return;
    try { await apiFetch("/rocks", { method: "POST", body: JSON.stringify({ tenant_id: vcbTenant, title, workstream_id: wsId }) }); load(); }
    catch (e) { setError(e.message); }
  }

  const list = vcbs || [];
  const active = list.filter((v) => !v.archived);

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Value Creation Blueprints</h1>
          <p className="page-sub">Multi-year strategic initiatives — Rocks ladder up to workstreams and roll up here.</p>
        </div>
        <div className="head-actions">
          <label className="checkbox-label"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          {activeTenantId && isLeader && <button className="btn-secondary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "+ New VCB"}</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!activeTenantId && <div className="ok-banner">Pick a specific PortCo from the switcher to create a VCB. Rollup shows every portfolio VCB.</div>}

      {showNew && (
        <form className="card inline-form" onSubmit={createVcb}>
          <div className="admin-grid">
            <label>Title<input value={nv.title} onChange={(e) => setNv({ ...nv, title: e.target.value })} required placeholder="Margin Expansion Blueprint" /></label>
            <label>Investment thesis
              <select value={nv.investment_thesis} onChange={(e) => setNv({ ...nv, investment_thesis: e.target.value })}>
                {THESES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>Measurable outcome<input value={nv.outcome} onChange={(e) => setNv({ ...nv, outcome: e.target.value })} placeholder="EBITDA margin 18% → 24%" /></label>
            <label>Start<input type="date" value={nv.start_date} onChange={(e) => setNv({ ...nv, start_date: e.target.value })} /></label>
            <label>End (12–36 mo)<input type="date" value={nv.end_date} onChange={(e) => setNv({ ...nv, end_date: e.target.value })} /></label>
            <label className="span-2">Description<input value={nv.description} onChange={(e) => setNv({ ...nv, description: e.target.value })} placeholder="How this ladders up to the investment thesis" /></label>
          </div>
          <p className="mini-label">Initial workstreams</p>
          <div className="admin-grid">
            {nv.workstreams.map((w, i) => (
              <label key={i}>Workstream {i + 1}
                <input value={w} onChange={(e) => { const a = [...nv.workstreams]; a[i] = e.target.value; setNv({ ...nv, workstreams: a }); }}
                  placeholder={["Procurement & COGS", "Pricing & Revenue", "Labor Productivity"][i] || "Name"} />
              </label>
            ))}
            <button type="button" className="btn-mini ghost" onClick={() => setNv({ ...nv, workstreams: [...nv.workstreams, ""] })}>+ workstream</button>
          </div>
          <button className="btn-secondary" type="submit">Create VCB</button>
        </form>
      )}

      {!vcbs && !error && <p className="loading-line">Loading VCBs…</p>}
      {vcbs && active.length === 0 && !showArchived && (
        <div className="empty-state"><p className="display">No VCBs yet</p><p>Leadership defines 2–3 blueprints per planning period.</p></div>
      )}

      {/* dashboard card grid */}
      <div className="vcb-grid">
        {list.map((v) => (
          <div className={`vcb-card ${v.archived ? "archived" : ""}`} key={v.id} onClick={() => setOpenId(openId === v.id ? null : v.id)}>
            <div className="vcb-card-head">
              <span className={`rag-pill ${statusClass(v.status)}`}>{STATUS_LABEL[v.status]}</span>
              {v.archived && <span className="freq-tag">archived</span>}
            </div>
            <p className="vcb-title">{v.title}</p>
            {v.investment_thesis && <p className="vcb-thesis">🎯 {v.investment_thesis}</p>}
            {!activeTenantId && <p className="card-meta">{v.tenant_name}</p>}
            <div className="progress-track"><div className="progress-fill" style={{ width: `${v.progress_pct}%` }} /></div>
            <p className="vcb-meta">{v.progress_pct}% · {v.complete_rocks}/{v.total_rocks} rocks · {v.workstreams.length} workstreams</p>
            {v.end_date && <p className="vcb-dates">{v.start_date || "—"} → {v.end_date}</p>}
          </div>
        ))}
      </div>

      {/* drill-down */}
      {openId && (() => {
        const v = list.find((x) => x.id === openId);
        if (!v) return null;
        const canEdit = isLeader;
        return (
          <div className="card vcb-drill">
            <div className="card-row">
              <div>
                <p className="card-title">{v.title} <span className={`rag-pill ${statusClass(v.status)}`}>{STATUS_LABEL[v.status]}</span></p>
                {v.description && <p className="card-desc">{v.description}</p>}
                {v.outcome && <p className="card-meta">Outcome: {v.outcome}</p>}
              </div>
              {canEdit && (
                <div className="head-actions">
                  <select className="mini-input" value={v.status} onChange={(e) => setVcbStatus(v.id, e.target.value)}>
                    {ROCK_STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                  {!v.archived && <button className="btn-mini ghost" onClick={() => archiveVcb(v.id)}>Archive</button>}
                  <button className="link-danger" onClick={() => delVcb(v.id)}>Delete</button>
                </div>
              )}
            </div>

            {/* spreadsheet-style grid: workstream -> rocks */}
            {v.workstreams.map((w) => (
              <div className="ws-block" key={w.id}>
                <div className="ws-head">
                  {canEdit
                    ? <input className="ws-name-input" defaultValue={w.name} onBlur={(e) => e.target.value !== w.name && renameWorkstream(w.id, e.target.value)} />
                    : <span className="ws-name">{w.name}</span>}
                  <span className="ws-progress"><span className="progress-track sm"><span className="progress-fill" style={{ width: `${w.progress_pct}%` }} /></span>{w.progress_pct}% · {w.complete_rocks}/{w.total_rocks}</span>
                  {canEdit && <button className="link-muted" onClick={() => delWorkstream(w.id)}>remove</button>}
                </div>
                <table className="grid-table">
                  <thead><tr><th>Rock</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                  <tbody>
                    {w.rocks.map((r) => (
                      <tr key={r.id}>
                        <td>{r.title}</td>
                        <td className="muted">{r.owner_name || "—"}</td>
                        <td className="muted">{r.due_date || "—"}</td>
                        <td>
                          {canEdit
                            ? <select className="mini-input sm" value={r.status} onChange={(e) => patchRock(r.id, { status: e.target.value })}>
                                {ROCK_STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                              </select>
                            : <span className={`rag-pill ${statusClass(r.status)}`}>{STATUS_LABEL[r.status]}</span>}
                        </td>
                      </tr>
                    ))}
                    {w.rocks.length === 0 && <tr><td colSpan={4} className="muted">No rocks linked yet.</td></tr>}
                    {canEdit && (
                      <tr className="add-row">
                        <td colSpan={4}>
                          <button className="add-rock-btn" onClick={() => setCreateRockWs({ tenantId: v.tenant_id, workstreamId: w.id })}>
                            + add a rock to this workstream
                          </button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ))}

            {canEdit && (
              <div className="card-actions">
                <input className="mini-input" placeholder="New workstream name" value={wsDraft[v.id] || ""}
                  onChange={(e) => setWsDraft({ ...wsDraft, [v.id]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && addWorkstream(v.id)} />
                <button className="btn-mini" onClick={() => addWorkstream(v.id)}>+ Workstream</button>
              </div>
            )}
          </div>
        );
      })()}

      <CreateDrawer
        open={!!createRockWs}
        onClose={() => setCreateRockWs(null)}
        tenantId={createRockWs?.tenantId}
        initialType="rock"
        initialWorkstreamId={createRockWs?.workstreamId}
        onCreated={() => load()}
      />
    </div>
  );
}

function statusClass(s) { return s === "complete" ? "GREEN" : s === "off_track" ? "RED" : "YELLOW"; }
