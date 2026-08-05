"use client";
import { useEffect, useState } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const BLANK = {
  title: "", description: "", target_value: "", green_threshold: "", red_threshold: "",
  direction: "higher_is_better", frequency: "weekly", unit: "units", owner_id: "",
};

export default function ScorecardsPage() {
  const { activeTenantId, can } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nk, setNk] = useState(BLANK);
  const [editId, setEditId] = useState(null);
  const [ev, setEv] = useState(BLANK);
  const [scoreDraft, setScoreDraft] = useState({});   // kpi_id -> value (single entry)
  const [bulkMode, setBulkMode] = useState(false);
  const [bulk, setBulk] = useState({});               // kpi_id -> value (bulk entry)
  const [freqFilter, setFreqFilter] = useState("all");

  function load() {
    apiFetch("/scorecards").then(setKpis).catch((e) => setError(e.message));
  }
  useEffect(() => {
    setKpis(null); load();
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => setPeople([]));
    /* eslint-disable-next-line */
  }, [activeTenantId]);

  const periodWord = (f) => (f === "monthly" ? "month" : "week");

  function payloadFrom(f) {
    return {
      title: f.title,
      description: f.description || null,
      target_value: Number(f.target_value || 0),
      green_threshold: f.green_threshold === "" ? Number(f.target_value || 0) : Number(f.green_threshold),
      red_threshold: f.red_threshold === "" ? Number(f.target_value || 0) : Number(f.red_threshold),
      direction: f.direction,
      frequency: f.frequency,
      unit: f.unit,
      owner_id: f.owner_id || null,
    };
  }

  async function createKpi(e) {
    e.preventDefault();
    if (!activeTenantId || !nk.title.trim()) return;
    try {
      await apiFetch("/scorecards", { method: "POST", body: JSON.stringify({ tenant_id: activeTenantId, ...payloadFrom(nk) }) });
      setNk(BLANK); setShowNew(false); load();
    } catch (e) { setError(e.message); }
  }

  function startEdit(k) {
    setEditId(k.kpi_id);
    setEv({
      title: k.title, description: k.description || "", target_value: k.target_value,
      green_threshold: k.green_threshold ?? "", red_threshold: k.red_threshold ?? "",
      direction: k.direction, frequency: k.frequency, unit: k.unit || "units", owner_id: k.owner_id || "",
    });
  }
  async function saveEdit(id) {
    try {
      await apiFetch(`/scorecards/${id}`, { method: "PATCH", body: JSON.stringify(payloadFrom(ev)) });
      setEditId(null); load();
    } catch (e) { setError(e.message); }
  }

  async function delKpi(id) {
    if (!confirm("Delete this KPI and its history?")) return;
    try { await apiFetch(`/scorecards/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }
  async function exportFile(kind) {
    try { await apiDownload(`/reports/scorecard.${kind}?tenant_id=${activeTenantId}`, `scorecard.${kind}`); }
    catch (e) { setError(e.message); }
  }

  function stamp() { return new Date().toISOString().slice(0, 10) + "T23:59:59Z"; }

  async function addScore(id) {
    const v = scoreDraft[id];
    if (v === undefined || v === "") return;
    try {
      await apiFetch(`/scorecards/${id}/scores`, { method: "POST", body: JSON.stringify({ recorded_at: stamp(), actual_value: Number(v) }) });
      setScoreDraft({ ...scoreDraft, [id]: "" }); load();
    } catch (e) { setError(e.message); }
  }

  async function saveBulk() {
    const entries = Object.entries(bulk)
      .filter(([, v]) => v !== "" && v !== undefined)
      .map(([kpi_id, v]) => ({ kpi_id, recorded_at: stamp(), actual_value: Number(v) }));
    if (!entries.length) return;
    try {
      await apiFetch("/scorecards/scores/bulk", { method: "POST", body: JSON.stringify({ entries }) });
      setBulk({}); setBulkMode(false); load();
    } catch (e) { setError(e.message); }
  }

  async function move(idx, dir) {
    const arr = [...visible];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    setKpis(arr);   // optimistic
    try { await apiFetch("/scorecards/reorder", { method: "POST", body: JSON.stringify({ order: arr.map((k) => k.kpi_id) }) }); }
    catch (e) { setError(e.message); load(); }
  }

  const visible = (kpis || []).filter((k) => freqFilter === "all" || k.frequency === freqFilter);

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Scorecards</h1>
          <p className="page-sub">Measurables with Red / Yellow / Green status — most recent 13 periods.</p>
        </div>
        <div className="head-actions">
          <select className="mini-input" value={freqFilter} onChange={(e) => setFreqFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          {activeTenantId && kpis && kpis.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => exportFile("xlsx")}>Export Excel</button>
              <button className="btn-ghost" onClick={() => exportFile("pdf")}>Export PDF</button>
            </>
          )}
          {activeTenantId && can("create") && kpis && kpis.length > 0 && (
            <button className="btn-ghost" onClick={() => { setBulkMode((b) => !b); setBulk({}); }}>{bulkMode ? "Cancel bulk" : "Bulk entry"}</button>
          )}
          {activeTenantId && can("create") && <button className="btn-secondary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "+ New KPI"}</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showNew && <KpiForm f={nk} setF={setNk} people={people} onSubmit={createKpi} submitLabel="Create KPI" />}

      {bulkMode && can("create") && (
        <div className="card">
          <p className="card-title">Bulk entry — this {periodWord(visible[0]?.frequency)}</p>
          <div className="bulk-grid">
            {visible.map((k) => (
              <label key={k.kpi_id} className="bulk-cell">
                <span>{k.title}</span>
                <input className="mini-input" type="number" step="any" placeholder={k.unit}
                  value={bulk[k.kpi_id] ?? ""} onChange={(e) => setBulk({ ...bulk, [k.kpi_id]: e.target.value })} />
              </label>
            ))}
          </div>
          <button className="btn-secondary" onClick={saveBulk} style={{ marginTop: 12 }}>Save all entries</button>
        </div>
      )}

      {!kpis && !error && <p className="loading-line">Loading scorecards…</p>}
      {kpis && visible.length === 0 && (
        <div className="empty-state"><p className="display">No scorecards here yet</p><p>Add a KPI with “+ New KPI”.</p></div>
      )}

      {kpis && visible.map((k, idx) => {
        const latest = k.weekly_history[k.weekly_history.length - 1];
        const rag = k.current_rag || "GREEN";
        const dirLabel = k.direction === "lower_is_better" ? "lower is better" : "higher is better";
        const band = k.green_threshold === k.red_threshold
          ? `goal ${k.target_value}`
          : `green @ ${k.green_threshold} · red @ ${k.red_threshold}`;
        if (editId === k.kpi_id) {
          return <div className="card" key={k.kpi_id}><KpiForm f={ev} setF={setEv} people={people}
            onSubmit={(e) => { e.preventDefault(); saveEdit(k.kpi_id); }} submitLabel="Save changes"
            onCancel={() => setEditId(null)} /></div>;
        }
        return (
          <div className="card" key={k.kpi_id}>
            <div className="card-row">
              <div style={{ display: "flex", alignItems: "flex-start" }}>
                {can("edit") && (
                  <span className="reorder-btns">
                    <button className="btn-mini ghost" onClick={() => move(idx, -1)} disabled={idx === 0}>▲</button>
                    <button className="btn-mini ghost" onClick={() => move(idx, +1)} disabled={idx === visible.length - 1}>▼</button>
                  </span>
                )}
                <div>
                  <p className="card-title">{k.title} <span className={`rag-pill ${rag}`}>{rag}</span> <span className="freq-tag">{k.frequency}</span></p>
                  {k.description && <p className="card-desc">{k.description}</p>}
                  <p className="card-meta">Owner: {k.owner || "Unassigned"} · {band} · {k.unit} · {dirLabel}</p>
                </div>
              </div>
              <div className="kpi-numbers">
                <div className={`kpi-actual ${rag}`}>{latest ? latest.actual_value : "—"}</div>
                <div className="kpi-target">{k.unit} this {periodWord(k.frequency)}</div>
              </div>
            </div>

            <div className="sparkline-row">
              {k.weekly_history.map((w, i) => (
                <div key={i} className={`spark-bar ${w.rag || (w.status === "ON_TRACK" ? "GREEN" : "RED")}`}
                  style={{ height: `${8 + (w.actual_value / (Math.max(k.green_threshold, k.red_threshold) * 1.4 || 1)) * 26}px` }}
                  title={`${w.week_ending}: ${w.actual_value} (${w.rag || w.status})`} />
              ))}
            </div>

            {k.off_track_streak >= 3 && (
              <p className="streak-flag">⚠ Red {k.off_track_streak} {periodWord(k.frequency)}s running — an Issue is auto-created after 3.</p>
            )}

            <div className="card-actions">
              {can("create") && !bulkMode && <>
                <input className="mini-input" type="number" step="any" placeholder={`this ${periodWord(k.frequency)}'s value`}
                  value={scoreDraft[k.kpi_id] ?? ""} onChange={(e) => setScoreDraft({ ...scoreDraft, [k.kpi_id]: e.target.value })} />
                <button className="btn-mini" onClick={() => addScore(k.kpi_id)}>Add score</button>
              </>}
              {can("edit") && <button className="btn-mini ghost" onClick={() => startEdit(k)}>Edit</button>}
              {can("delete") && <button className="link-danger" onClick={() => delKpi(k.kpi_id)}>Delete KPI</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KpiForm({ f, setF, people, onSubmit, submitLabel, onCancel }) {
  const up = (patch) => setF({ ...f, ...patch });
  return (
    <form className="card inline-form" onSubmit={onSubmit}>
      <div className="admin-grid">
        <label>Title<input value={f.title} onChange={(e) => up({ title: e.target.value })} required placeholder="Outbound Sales Calls" /></label>
        <label>Description<input value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="Calls logged in CRM" /></label>
        <label>Frequency
          <select value={f.frequency} onChange={(e) => up({ frequency: e.target.value })}>
            <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          </select>
        </label>
        <label>Direction
          <select value={f.direction} onChange={(e) => up({ direction: e.target.value })}>
            <option value="higher_is_better">Higher is better</option>
            <option value="lower_is_better">Lower is better</option>
          </select>
        </label>
        <label>Goal (green @)<input type="number" step="any" value={f.target_value} onChange={(e) => up({ target_value: e.target.value, green_threshold: e.target.value })} required /></label>
        <label>Green threshold<input type="number" step="any" value={f.green_threshold} onChange={(e) => up({ green_threshold: e.target.value })} placeholder="meets goal" /></label>
        <label>Red threshold<input type="number" step="any" value={f.red_threshold} onChange={(e) => up({ red_threshold: e.target.value })} placeholder="below = red" /></label>
        <label>Unit<input value={f.unit} onChange={(e) => up({ unit: e.target.value })} /></label>
        <label>Owner
          <select value={f.owner_id} onChange={(e) => up({ owner_id: e.target.value })}>
            <option value="">Unassigned</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <p className="form-hint">Yellow band sits between the green and red thresholds. Leave them equal for a simple pass/fail metric.</p>
      <div className="card-actions">
        <button className="btn-secondary" type="submit">{submitLabel}</button>
        {onCancel && <button type="button" className="link-muted" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
