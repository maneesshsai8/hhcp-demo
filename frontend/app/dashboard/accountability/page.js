"use client";
import { useEffect, useState, useRef } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import MultiSelect from "@/components/MultiSelect";

function buildTree(seats) {
  const byParent = {};
  seats.forEach((s) => { const k = s.parent_seat_id || "root"; (byParent[k] ||= []).push(s); });
  return byParent;
}

// GWC dot: green (yes) / red (no) / grey (not assessed). Clickable cycles ?→✓→✗→?.
function Gwc({ label, val, onCycle }) {
  const cls = val === true ? "GREEN" : val === false ? "RED" : "GREY";
  return <button type="button" className={`gwc-dot ${cls}`} title={`${label}: ${val === true ? "Yes" : val === false ? "No" : "not assessed"}`}
    onClick={onCycle ? (e) => { e.stopPropagation(); onCycle(); } : undefined}>{label}</button>;
}
const cycle = (v) => (v === null || v === undefined ? true : v === true ? false : null);

function SeatCard({ s, byParent, depth, dnd, onOpen, selectedId }) {
  const kids = byParent[s.id] || [];
  return (
    <div className="seat-branch" style={{ marginLeft: depth ? 20 : 0 }}>
      <div
        className={`seat-card ${selectedId === s.id ? "sel" : ""} ${dnd.overId === s.id ? "drop-over" : ""}`}
        draggable={dnd.enabled}
        onDragStart={(e) => { e.stopPropagation(); dnd.setDrag(s.id); }}
        onDragOver={(e) => { if (dnd.enabled) { e.preventDefault(); e.stopPropagation(); dnd.setOver(s.id); } }}
        onDragLeave={() => dnd.overId === s.id && dnd.setOver(null)}
        onDrop={(e) => { if (dnd.enabled) { e.preventDefault(); e.stopPropagation(); dnd.drop(s.id); } }}
        onClick={() => onOpen(s.id)}
      >
        <div className="seat-top">
          <span className="seat-title">{s.title}</span>
          <span className="gwc-row">
            <Gwc label="G" val={s.gwc_gets} /><Gwc label="W" val={s.gwc_wants} /><Gwc label="C" val={s.gwc_capacity} />
          </span>
        </div>
        <p className="seat-holder">
          {s.holders && s.holders.length ? s.holders.map((h) => h.name).join(", ") : (s.holder_name || "Vacant seat")}
          {s.holders && s.holders.length > 1 && <span className="freq-tag">shared</span>}
        </p>
        {s.responsibilities && (
          <ul className="seat-resp-list">
            {s.responsibilities.split("\n").map((r) => r.trim()).filter(Boolean).slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
      {kids.length > 0 && <div className="seat-children">
        {kids.map((k) => <SeatCard key={k.id} s={k} byParent={byParent} depth={depth + 1} dnd={dnd} onOpen={onOpen} selectedId={selectedId} />)}
      </div>}
    </div>
  );
}

const BLANK = { title: "", parent_seat_id: "", holder_ids: [], responsibilities: "", gwc_gets: null, gwc_wants: null, gwc_capacity: null };

export default function AccountabilityPage() {
  const { activeTenantId, can } = useAuth();
  const [seats, setSeats] = useState(null);
  const [people, setPeople] = useState([]);
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nf, setNf] = useState(BLANK);
  const [openId, setOpenId] = useState(null);     // seat detail panel
  const [ed, setEd] = useState(null);             // edit values for open seat
  const [links, setLinks] = useState(null);
  const dragId = useRef(null);
  const [overId, setOverId] = useState(null);
  const [view, setView] = useState("native");     // 'native' | 'lucid'
  const [embedUrl, setEmbedUrl] = useState(null);
  const [embedDraft, setEmbedDraft] = useState("");
  const [lucidMode, setLucidMode] = useState("cookie");  // 'cookie' | 'token'
  const [session, setSession] = useState(null);          // token-based embed-session response
  const [embedIdDraft, setEmbedIdDraft] = useState("");

  function load() {
    apiFetch("/seats").then(setSeats).catch((e) => setError(e.message));
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => {});
    apiFetch("/seats/versions").then(setVersions).catch(() => {});
    apiFetch(`/seats/embed${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then((d) => setEmbedUrl(d.embed_url)).catch(() => setEmbedUrl(null));
  }

  async function saveEmbed(clear) {
    try {
      const r = await apiFetch("/seats/embed", { method: "PUT", body: JSON.stringify({ tenant_id: activeTenantId, embed_url: clear ? null : embedDraft }) });
      setEmbedUrl(r.embed_url); setEmbedDraft(""); flash(clear ? "Lucidchart link removed." : "Lucidchart linked.");
    } catch (e) { setError(e.message); }
  }
  async function loadSession() {
    setSession(null);
    try { setSession(await apiFetch(`/seats/embed-session${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`)); }
    catch (e) { setSession({ error: e.message }); }
  }
  async function saveEmbedId(clear) {
    try {
      await apiFetch("/seats/embed-id", { method: "PUT", body: JSON.stringify({ tenant_id: activeTenantId, embed_id: clear ? null : embedIdDraft }) });
      setEmbedIdDraft(""); flash(clear ? "Token embed unlinked." : "Token embed linked."); loadSession();
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { setSeats(null); setOpenId(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  async function createSeat(e) {
    e.preventDefault();
    if (!activeTenantId || !nf.title.trim()) return;
    try {
      await apiFetch("/seats", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: nf.title, parent_seat_id: nf.parent_seat_id || null,
        holder_ids: nf.holder_ids, responsibilities: nf.responsibilities || null,
        gwc_gets: nf.gwc_gets, gwc_wants: nf.gwc_wants, gwc_capacity: nf.gwc_capacity,
      })});
      setNf(BLANK); setShowNew(false); load();
    } catch (e) { setError(e.message); }
  }

  async function openSeat(id) {
    setOpenId(id); setLinks(null);
    const s = seats.find((x) => x.id === id);
    setEd({ title: s.title, holder_ids: (s.holders || []).map((h) => h.id), responsibilities: s.responsibilities || "",
            gwc_gets: s.gwc_gets, gwc_wants: s.gwc_wants, gwc_capacity: s.gwc_capacity });
    try { setLinks(await apiFetch(`/seats/${id}/links`)); } catch { setLinks({ kpis: [], vcbs: [], todos: [] }); }
  }
  async function saveSeat() {
    try {
      await apiFetch(`/seats/${openId}`, { method: "PATCH", body: JSON.stringify({
        title: ed.title, holder_ids: ed.holder_ids, responsibilities: ed.responsibilities,
        gwc_gets: ed.gwc_gets, gwc_wants: ed.gwc_wants, gwc_capacity: ed.gwc_capacity,
      })});
      flash("Seat updated."); load();
    } catch (e) { setError(e.message); }
  }
  async function delSeat(id) {
    if (!confirm("Delete this seat? Seats reporting under it are removed too.")) return;
    try { await apiFetch(`/seats/${id}`, { method: "DELETE" }); setOpenId(null); load(); } catch (e) { setError(e.message); }
  }
  async function reparent(seatId, newParent) {
    if (seatId === newParent) return;
    try { await apiFetch(`/seats/${seatId}/reparent`, { method: "POST", body: JSON.stringify({ parent_seat_id: newParent }) }); load(); }
    catch (e) { setError(e.message); }
  }
  async function publish() {
    const label = prompt("Label this published version:", `Snapshot ${new Date().toLocaleDateString()}`);
    if (label === null) return;
    try { const r = await apiFetch("/seats/publish", { method: "POST", body: JSON.stringify({ tenant_id: activeTenantId, label: label || null }) });
      flash(`Published version with ${r.seat_count} seats.`); apiFetch("/seats/versions").then(setVersions); }
    catch (e) { setError(e.message); }
  }

  const canEdit = can("edit");
  const dnd = {
    enabled: canEdit, overId,
    setDrag: (id) => (dragId.current = id),
    setOver: setOverId,
    drop: (targetId) => { const d = dragId.current; dragId.current = null; setOverId(null); if (d) reparent(d, targetId); },
  };
  const byParent = seats ? buildTree(seats) : {};
  const open = openId && seats ? seats.find((s) => s.id === openId) : null;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Accountability Chart</h1>
          <p className="page-sub">Role-based seats with GWC (Gets it · Wants it · Capacity), responsibilities, and module ownership. {canEdit && "Drag a seat onto another to change who it reports to."}</p>
        </div>
        <div className="head-actions">
          <div className="seg">
            <button className={view === "native" ? "on" : ""} onClick={() => setView("native")}>Native chart</button>
            <button className={view === "lucid" ? "on" : ""} onClick={() => setView("lucid")}>Lucidchart{embedUrl ? " ●" : ""}</button>
          </div>
          {view === "native" && activeTenantId && seats && seats.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/orgchart.pdf?tenant_id=${activeTenantId}`, "org-chart.pdf").catch((e) => setError(e.message))}>Export PDF</button>
              <button className="btn-ghost" onClick={() => apiDownload(`/reports/orgchart.png?tenant_id=${activeTenantId}`, "org-chart.png").catch((e) => setError(e.message))}>Export PNG</button>
            </>
          )}
          {view === "native" && activeTenantId && canEdit && seats && seats.length > 0 && <button className="btn-ghost" onClick={publish}>Publish snapshot</button>}
          {view === "native" && activeTenantId && can("create") && <button className="btn-secondary" onClick={() => { setNf(BLANK); setShowNew((v) => !v); }}>{showNew ? "Cancel" : "+ Add seat"}</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      {/* ---- Lucidchart embed ---- */}
      {view === "lucid" && (
        <div className="card">
          <div className="seg" style={{ marginBottom: 14 }}>
            <button className={lucidMode === "cookie" ? "on" : ""} onClick={() => setLucidMode("cookie")}>Cookie-based</button>
            <button className={lucidMode === "token" ? "on" : ""} onClick={() => { setLucidMode("token"); loadSession(); }}>Token-based (no login)</button>
          </div>

          {lucidMode === "cookie" ? (
            embedUrl ? (
              <>
                <div className="lucid-embed">
                  <iframe src={embedUrl} title="Accountability Chart (Lucidchart)" allowFullScreen loading="lazy" />
                </div>
                <p className="card-meta" style={{ marginTop: 8 }}>
                  Cookie-based embed — the viewer&rsquo;s own Lucid/SSO session authenticates it, no API keys involved.
                  {canEdit && <> · <a href={embedUrl} target="_blank" rel="noopener noreferrer">Open in Lucid</a> · <button className="link-danger" onClick={() => saveEmbed(true)}>Remove link</button></>}
                </p>
              </>
            ) : canEdit ? (
              <div className="lucid-setup">
                <p className="card-title">Link a Lucidchart chart (cookie-based)</p>
                <p className="card-meta">In Lucidchart: <strong>File → Share → Embed → Activate Embed Code</strong>, then paste the embed URL (or the whole <code>&lt;iframe&gt;</code> snippet). Only lucid.app / lucidchart.com links are accepted.</p>
                <div className="add-rock-inline" style={{ marginTop: 10 }}>
                  <input className="mini-input" value={embedDraft} onChange={(e) => setEmbedDraft(e.target.value)} placeholder='https://lucid.app/documents/embed/…  (or paste the <iframe> code)' />
                  <button className="btn-secondary" onClick={() => saveEmbed(false)} disabled={!embedDraft.trim()}>Link chart</button>
                </div>
              </div>
            ) : <div className="empty-state"><p className="display">No Lucidchart linked</p><p>An admin can link one for this tenant.</p></div>
          ) : (
            /* ---- token-based (Approach 2) ---- */
            !session ? <p className="loading-line">Minting a session token…</p>
            : session.configured === false ? (
              <div className="lucid-setup">
                <p className="card-title">Token-based embeds — one-time backend setup needed</p>
                <p className="card-meta">Viewers won&rsquo;t need a Lucid account or ever see a login prompt: the server mints a short-lived token per view. It needs a Lucid OAuth app + refresh token kept in <code>backend/.env</code> (never the browser).</p>
                <ol className="setup-steps">
                  <li>Create an OAuth 2.0 client at developer.lucid.co (scopes <code>offline_access</code> + <code>lucidchart.document.app.picker</code>).</li>
                  <li>Run <code>python scripts/lucid_oauth.py</code> once, authorize, and paste the printed <code>LUCID_*</code> lines into <code>backend/.env</code>.</li>
                  <li>Restart the backend, then set this tenant&rsquo;s Lucid embed id below.</li>
                </ol>
                <p className="fld-opt">Server status: Lucid OAuth credentials not detected. (See docs/LUCIDCHART-EMBED.md.)</p>
              </div>
            ) : session.embed_url ? (
              <>
                <div className="lucid-embed"><iframe src={session.embed_url} title="Accountability Chart (Lucidchart token)" allowFullScreen loading="lazy" /></div>
                <p className="card-meta" style={{ marginTop: 8 }}>
                  Rendered via a short-lived, server-minted session token — no viewer login, no keys in the browser.
                  {canEdit && <> · <button className="btn-mini ghost" onClick={loadSession}>Refresh token</button> · <button className="link-danger" onClick={() => saveEmbedId(true)}>Unlink</button></>}
                </p>
              </>
            ) : canEdit ? (
              <div className="lucid-setup">
                <p className="card-title">Link a Lucid embed (token-based)</p>
                <p className="card-meta">Credentials are configured on the server. Enter the Lucid <strong>embed id</strong> for this tenant&rsquo;s chart (from the Embed API / document).</p>
                <div className="add-rock-inline" style={{ marginTop: 10 }}>
                  <input className="mini-input" value={embedIdDraft} onChange={(e) => setEmbedIdDraft(e.target.value)} placeholder="Lucid embed id (e.g. 6867b573-b774-…)" />
                  <button className="btn-secondary" onClick={() => saveEmbedId(false)} disabled={!embedIdDraft.trim()}>Link</button>
                </div>
              </div>
            ) : <div className="empty-state"><p className="display">No token embed set</p><p>An admin can link one for this tenant.</p></div>
          )}
        </div>
      )}

      {view === "native" && <>
      {showNew && (
        <form className="card inline-form" onSubmit={createSeat}>
          <div className="admin-grid">
            <label>Seat / role title<input value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} required placeholder="Integrator" /></label>
            <label>Reports to
              <select value={nf.parent_seat_id} onChange={(e) => setNf({ ...nf, parent_seat_id: e.target.value })}>
                <option value="">Top level (no parent)</option>
                {(seats || []).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            </label>
            <label>Held by <span className="fld-opt">(one or more)</span>
              <MultiSelect options={people} selected={nf.holder_ids} onToggle={(id) => setNf((f) => ({ ...f, holder_ids: f.holder_ids.includes(id) ? f.holder_ids.filter((x) => x !== id) : [...f.holder_ids, id] }))} placeholder="Assign people…" />
            </label>
          </div>
          <label className="fld">Responsibilities <span className="fld-opt">(one per line, up to 5)</span>
            <textarea value={nf.responsibilities} onChange={(e) => setNf({ ...nf, responsibilities: e.target.value })} placeholder={"Vision & culture\nBig relationships\nFinal decisions"} />
          </label>
          <div className="gwc-edit">
            <span className="mini-label" style={{ margin: 0 }}>GWC</span>
            <Gwc label="G" val={nf.gwc_gets} onCycle={() => setNf((f) => ({ ...f, gwc_gets: cycle(f.gwc_gets) }))} />
            <Gwc label="W" val={nf.gwc_wants} onCycle={() => setNf((f) => ({ ...f, gwc_wants: cycle(f.gwc_wants) }))} />
            <Gwc label="C" val={nf.gwc_capacity} onCycle={() => setNf((f) => ({ ...f, gwc_capacity: cycle(f.gwc_capacity) }))} />
            <span className="fld-opt">click to cycle: not-assessed → yes → no</span>
          </div>
          <button className="btn-secondary" type="submit">Add seat</button>
        </form>
      )}

      {!seats && !error && <p className="loading-line">Loading chart…</p>}
      {seats && seats.length === 0 && (
        <div className="empty-state"><p className="display">No seats yet</p><p>Start with a top-level seat (e.g. Visionary), then add seats reporting under it.</p></div>
      )}

      {seats && seats.length > 0 && (
        <div className="org-layout">
          <div
            className={`seat-tree ${overId === "root" ? "drop-over" : ""}`}
            onDragOver={(e) => { if (dnd.enabled) { e.preventDefault(); setOverId("root"); } }}
            onDrop={(e) => { if (dnd.enabled) { e.preventDefault(); const d = dragId.current; dragId.current = null; setOverId(null); if (d) reparent(d, null); } }}
          >
            {(byParent["root"] || []).map((s) => <SeatCard key={s.id} s={s} byParent={byParent} depth={0} dnd={dnd} onOpen={openSeat} selectedId={openId} />)}
            {canEdit && <p className="fld-opt" style={{ marginTop: 10 }}>Drop a seat here to move it to the top level.</p>}
          </div>

          {open && ed && (
            <aside className="seat-detail card">
              <div className="card-row">
                <input className="seat-detail-title" value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} disabled={!canEdit} />
                <button className="link-muted" onClick={() => setOpenId(null)}>✕</button>
              </div>

              <p className="mini-label">GWC assessment</p>
              <div className="gwc-edit">
                <Gwc label="G" val={ed.gwc_gets} onCycle={canEdit ? () => setEd({ ...ed, gwc_gets: cycle(ed.gwc_gets) }) : null} />
                <Gwc label="W" val={ed.gwc_wants} onCycle={canEdit ? () => setEd({ ...ed, gwc_wants: cycle(ed.gwc_wants) }) : null} />
                <Gwc label="C" val={ed.gwc_capacity} onCycle={canEdit ? () => setEd({ ...ed, gwc_capacity: cycle(ed.gwc_capacity) }) : null} />
                <span className="fld-opt">Gets it · Wants it · Capacity</span>
              </div>

              <p className="mini-label">Held by</p>
              {canEdit
                ? <MultiSelect options={people} selected={ed.holder_ids} onToggle={(id) => setEd((f) => ({ ...f, holder_ids: f.holder_ids.includes(id) ? f.holder_ids.filter((x) => x !== id) : [...f.holder_ids, id] }))} placeholder="Assign people…" />
                : <p className="card-meta">{(open.holders || []).map((h) => h.name).join(", ") || "Vacant"}</p>}

              <p className="mini-label">Responsibilities <span className="fld-opt">(up to 5)</span></p>
              {canEdit
                ? <textarea className="mini-input" style={{ width: "100%", minHeight: 90 }} value={ed.responsibilities} onChange={(e) => setEd({ ...ed, responsibilities: e.target.value })} />
                : <ul className="seat-resp-list">{(open.responsibilities || "").split("\n").filter(Boolean).slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}</ul>}

              <p className="mini-label">Linked ownership</p>
              {!links ? <p className="fld-opt">Loading…</p> : (
                <div className="seat-links">
                  <LinkGroup title="Scorecard KPIs" items={links.kpis} />
                  <LinkGroup title="VCBs" items={links.vcbs} />
                  <LinkGroup title="Open To-Dos" items={links.todos} />
                </div>
              )}

              {canEdit && (
                <div className="card-actions" style={{ marginTop: 12 }}>
                  <button className="btn-secondary" onClick={saveSeat}>Save changes</button>
                  {can("delete") && <button className="link-danger" onClick={() => delSeat(open.id)}>Delete seat</button>}
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="card-title">Version history</p>
          <table className="admin-table">
            <thead><tr><th>When</th><th>Label</th><th>Seats</th><th>By</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.created_at).toLocaleString()}</td>
                  <td>{v.label || "—"}</td><td>{v.seat_count}</td><td>{v.created_by_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>}
    </div>
  );
}

function LinkGroup({ title, items }) {
  return (
    <div className="link-group">
      <span className="link-group-title">{title} ({items.length})</span>
      {items.length === 0 ? <span className="fld-opt"> none</span> : <ul>{items.map((i) => <li key={i.id}>{i.title}</li>)}</ul>}
    </div>
  );
}
