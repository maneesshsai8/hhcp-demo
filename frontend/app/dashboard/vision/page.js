"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const LEADERSHIP = new Set(["fund_admin", "lead_partner", "deal_qb", "portco_management"]);
const EMPTY = { mission: "", vision: "", core_values: "" };

export default function VisionPage() {
  const { activeTenantId, activeRole, user } = useAuth();
  const [doc, setDoc] = useState(null);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const canEdit = !!user?.is_fund_admin || LEADERSHIP.has(activeRole);

  function load() {
    setDoc(null); setEdit(false);
    apiFetch("/vision").then(setDoc).catch((e) => setError(e.message));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  function startEdit() {
    setF({ mission: doc.mission || "", vision: doc.vision || "", core_values: doc.core_values || "" });
    setEdit(true);
  }
  async function save() {
    try {
      await apiFetch("/vision", { method: "PUT", body: JSON.stringify({
        tenant_id: activeTenantId, mission: f.mission || null, vision: f.vision || null, core_values: f.core_values || null,
      })});
      setMsg("Vision published — visible company-wide."); setTimeout(() => setMsg(""), 3500);
      load();
    } catch (e) { setError(e.message); }
  }

  const isEmpty = doc && !doc.mission && !doc.vision && !doc.core_values;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Vision</h1>
          <p className="page-sub">The company&rsquo;s Mission, Vision, and Core Values — a shared reference for everyone.</p>
        </div>
        {activeTenantId && canEdit && !edit && (
          <div className="head-actions"><button className="btn-secondary" onClick={startEdit}>Edit</button></div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      {!activeTenantId && <div className="ok-banner">Pick a specific company from the switcher to view or edit its Vision.</div>}
      {activeTenantId && !doc && !error && <p className="loading-line">Loading…</p>}

      {activeTenantId && doc && !edit && (
        <>
          {isEmpty ? (
            <div className="empty-state">
              <p className="display">No Vision published yet</p>
              <p>{canEdit ? "Use Edit to publish your Mission, Vision, and Core Values." : "Leadership hasn't published this company's Vision yet."}</p>
            </div>
          ) : (
            <div className="vision-doc">
              <VisionSection title="Mission" text={doc.mission} />
              <VisionSection title="Vision" text={doc.vision} />
              <VisionSection title="Core Values" text={doc.core_values} />
              {doc.updated_at && (
                <p className="vision-meta">Last updated{doc.updated_by_name ? ` by ${doc.updated_by_name}` : ""} on {new Date(doc.updated_at).toLocaleDateString()}.</p>
              )}
            </div>
          )}
        </>
      )}

      {activeTenantId && edit && (
        <div className="card vision-editor">
          <label className="fld">Mission
            <textarea value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} placeholder="Why the company exists — its purpose." />
          </label>
          <label className="fld">Vision
            <textarea value={f.vision} onChange={(e) => setF({ ...f, vision: e.target.value })} placeholder="Where the company is going — the long-term picture." />
          </label>
          <label className="fld">Core Values <span className="fld-opt">(one per line)</span>
            <textarea value={f.core_values} onChange={(e) => setF({ ...f, core_values: e.target.value })} placeholder={"Integrity first\nCustomer obsession\nOwn the outcome"} />
          </label>
          <div className="card-actions">
            <button className="btn-secondary" onClick={save}>Publish</button>
            <button className="link-muted" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function VisionSection({ title, text }) {
  if (!text) return null;
  return (
    <section className="vision-section">
      <h2 className="vision-title display">{title}</h2>
      <p className="vision-body">{text}</p>
    </section>
  );
}
