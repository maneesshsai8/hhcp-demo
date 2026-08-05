"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

// order tenants Fund → PortCo → Add-on with indentation depth. A node roots the
// VISIBLE subtree when its parent is null OR outside what the caller can see
// (e.g. a PortCo user whose parent Fund is invisible) — otherwise it'd orphan.
function hierarchy(rows) {
  const ids = new Set(rows.map((r) => r.tenant_id));
  const byParent = {};
  rows.forEach((r) => { const p = (r.parent_tenant_id && ids.has(r.parent_tenant_id)) ? r.parent_tenant_id : "root"; (byParent[p] ||= []).push(r); });
  const out = [];
  (function walk(pid, depth) {
    (byParent[pid] || []).sort((a, b) => a.name.localeCompare(b.name)).forEach((r) => {
      out.push({ ...r, depth });
      walk(r.tenant_id, depth + 1);
    });
  })("root", 0);
  return out;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try { setData(await apiFetch("/federation/rollup")); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const ft = data?.fund_total;
  const rows = data ? hierarchy(data.tenants) : [];
  const scopeLabel = user?.is_fund_admin ? "Portfolio-wide" : "Across your workspaces";
  const multi = rows.length > 1;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Dashboard</h1>
          <p className="page-sub">{scopeLabel} overview — aggregated live across the Fund → PortCo → Add-on hierarchy.</p>
        </div>
        <div className="head-actions">
          <button className="btn-secondary" onClick={load} disabled={busy}>{busy ? "Running…" : "↻ Refresh"}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <p className="loading-line">Running federated rollup…</p>}

      {/* query-time fan-out telemetry — the "make the query, show its cost" bit */}
      {data && (
        <div className="fed-querybar">
          <span className="fed-qb-tag">query-time fan-out</span>
          <span>Scanned <strong>{data.tenants_scanned}</strong> tenant{data.tenants_scanned !== 1 ? "s" : ""} with <strong>{data.queries_run}</strong> live GROUP BY queries in <strong>{data.fanout_ms}ms</strong>.</span>
        </div>
      )}

      {ft && (
        <>
          <div className="fed-cards">
            <SummaryCard label="Rocks" main={`${ft.rocks.complete}/${ft.rocks.total}`} sub={`${data.fund_rock_completion_pct}% complete · ${ft.rocks.off_track} off-track`} />
            <SummaryCard label="Issues" main={ft.issues.open} sub={`open · ${ft.issues.solved} resolved`} />
            <SummaryCard label="To-Dos" main={ft.todos.overdue} sub={`overdue · ${ft.todos.done}/${ft.todos.total} done`} />
            <SummaryCard label="KPIs tracked" main={ft.kpis.count} sub={scopeLabel.toLowerCase()} />
            <SummaryCard label="VCBs" main={ft.vcbs.count} sub={`${ft.vcbs.rock_total ? Math.round(ft.vcbs.rock_done / ft.vcbs.rock_total * 100) : 0}% rocks done`} />
          </div>

          {multi && (
            <div className="card">
              <p className="card-title">By tenant <span className="card-meta" style={{ fontWeight: 400 }}>— each row rolls up itself + everything beneath it</span></p>
              <div style={{ overflowX: "auto" }}>
                <table className="admin-table fed-table">
                  <thead><tr>
                    <th>Tenant</th><th>Rocks (✓/total)</th><th>Off-track</th><th>Issues open</th><th>To-Dos overdue</th><th>KPIs</th><th>Rock completion</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((t) => {
                      const r = t.rollup;
                      return (
                        <tr key={t.tenant_id}>
                          <td style={{ paddingLeft: 12 + t.depth * 20 }}>
                            {t.depth > 0 && <span className="fed-tree">› </span>}{t.name}
                            <span className={`tier-tag ${t.tenant_type}`}>{t.tenant_type}</span>
                          </td>
                          <td>{r.rocks.complete}/{r.rocks.total}</td>
                          <td>{r.rocks.off_track > 0 ? <span className="prio-pill high">{r.rocks.off_track}</span> : "—"}</td>
                          <td>{r.issues.open || "—"}</td>
                          <td>{r.todos.overdue > 0 ? <span className="overdue-tag">{r.todos.overdue}</span> : "—"}</td>
                          <td>{r.kpis.count || "—"}</td>
                          <td>
                            <span className="progress-track sm"><span className="progress-fill" style={{ width: `${t.rock_completion_pct}%` }} /></span>
                            {t.rock_completion_pct}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="fed-foot">Approach 1 (query-time fan-out): no pre-computed tables — every number above is aggregated live from each tenant when this page loads, scoped by row-level security to exactly what you can access.</p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, main, sub }) {
  return (
    <div className="fed-card">
      <p className="fed-card-label">{label}</p>
      <p className="fed-card-main">{main}</p>
      <p className="fed-card-sub">{sub}</p>
    </div>
  );
}
