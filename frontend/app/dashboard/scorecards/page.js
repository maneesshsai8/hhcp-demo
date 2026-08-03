"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const OPS = [">=", "<=", "="];

export default function ScorecardsPage() {
  const { activeTenantId } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nk, setNk] = useState({ title: "", target_value: "", comparison_operator: ">=", unit: "units" });
  const [scoreDraft, setScoreDraft] = useState({}); // kpi_id -> value

  function load() {
    apiFetch("/scorecards").then(setKpis).catch((e) => setError(e.message));
  }
  useEffect(() => { setKpis(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function createKpi(e) {
    e.preventDefault();
    if (!activeTenantId || !nk.title.trim()) return;
    try {
      await apiFetch("/scorecards", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: nk.title,
        target_value: Number(nk.target_value || 0), comparison_operator: nk.comparison_operator, unit: nk.unit,
      })});
      setNk({ title: "", target_value: "", comparison_operator: ">=", unit: "units" });
      setShowNew(false); load();
    } catch (e) { setError(e.message); }
  }
  async function delKpi(id) {
    if (!confirm("Delete this KPI and its history?")) return;
    try { await apiFetch(`/scorecards/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }
  async function addScore(id) {
    const v = scoreDraft[id];
    if (v === undefined || v === "") return;
    try {
      const today = new Date().toISOString().slice(0, 10) + "T23:59:59Z";
      await apiFetch(`/scorecards/${id}/scores`, { method: "POST", body: JSON.stringify({ recorded_at: today, actual_value: Number(v) }) });
      setScoreDraft({ ...scoreDraft, [id]: "" }); load();
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Scorecards</h1>
          <p className="page-sub">Weekly measurables, most recent 13 weeks.</p>
        </div>
        {activeTenantId && <button className="btn-secondary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "+ New KPI"}</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showNew && (
        <form className="card inline-form" onSubmit={createKpi}>
          <div className="admin-grid">
            <label>Title<input value={nk.title} onChange={(e) => setNk({ ...nk, title: e.target.value })} required placeholder="Outbound Sales Calls" /></label>
            <label>Target<input type="number" step="any" value={nk.target_value} onChange={(e) => setNk({ ...nk, target_value: e.target.value })} required /></label>
            <label>Operator<select value={nk.comparison_operator} onChange={(e) => setNk({ ...nk, comparison_operator: e.target.value })}>{OPS.map((o) => <option key={o}>{o}</option>)}</select></label>
            <label>Unit<input value={nk.unit} onChange={(e) => setNk({ ...nk, unit: e.target.value })} /></label>
          </div>
          <button className="btn-secondary" type="submit">Create KPI</button>
        </form>
      )}

      {!kpis && !error && <p className="loading-line">Loading scorecards…</p>}
      {kpis && kpis.length === 0 && (
        <div className="empty-state"><p className="display">No scorecards here yet</p><p>Add a KPI with “+ New KPI”.</p></div>
      )}

      {kpis && kpis.map((k) => {
        const latest = k.weekly_history[k.weekly_history.length - 1];
        return (
          <div className="card" key={k.kpi_id}>
            <div className="card-row">
              <div>
                <p className="card-title">{k.title}</p>
                <p className="card-meta">Owner: {k.owner || "Unassigned"} &middot; Target {k.comparison_operator} {k.target_value} {k.unit}</p>
              </div>
              <div className="kpi-numbers">
                <div className="kpi-actual">{latest ? latest.actual_value : "—"}</div>
                <div className="kpi-target">{k.unit} this week</div>
              </div>
            </div>

            <div className="sparkline-row">
              {k.weekly_history.map((w, i) => (
                <div key={i} className={`spark-bar ${w.status === "ON_TRACK" ? "on" : "off"}`}
                  style={{ height: `${8 + (w.actual_value / (k.target_value * 1.4 || 1)) * 26}px` }}
                  title={`${w.week_ending}: ${w.actual_value} (${w.status})`} />
              ))}
            </div>

            {k.off_track_streak >= 3 && (
              <p className="streak-flag">⚠ Off-track {k.off_track_streak} weeks running — an Issue is auto-created after 3.</p>
            )}

            <div className="card-actions">
              <input className="mini-input" type="number" step="any" placeholder="this week's value"
                value={scoreDraft[k.kpi_id] ?? ""} onChange={(e) => setScoreDraft({ ...scoreDraft, [k.kpi_id]: e.target.value })} />
              <button className="btn-mini" onClick={() => addScore(k.kpi_id)}>Add score</button>
              <button className="link-danger" onClick={() => delKpi(k.kpi_id)}>Delete KPI</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
