"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

function buildTree(seats) {
  const byParent = {};
  seats.forEach((s) => {
    const key = s.parent_seat_id || "root";
    (byParent[key] = byParent[key] || []).push(s);
  });
  return byParent;
}

function SeatNodes({ nodes, byParent, depth, onDelete }) {
  return nodes.map((s) => (
    <div key={s.id} className="seat-branch" style={{ marginLeft: depth * 22 }}>
      <div className="seat-card">
        <div className="seat-head">
          <span className="seat-title">{s.title}</span>
          <button className="link-danger" onClick={() => onDelete(s.id)}>Delete</button>
        </div>
        <p className="seat-holder">{s.holder_name ? `Held by ${s.holder_name}` : "Vacant seat"}</p>
        {s.responsibilities && <p className="seat-resp">{s.responsibilities}</p>}
      </div>
      {byParent[s.id] && <SeatNodes nodes={byParent[s.id]} byParent={byParent} depth={depth + 1} onDelete={onDelete} />}
    </div>
  ));
}

export default function AccountabilityPage() {
  const { activeTenantId } = useAuth();
  const [seats, setSeats] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [s, setS] = useState({ title: "", parent_seat_id: "", holder_user_id: "", responsibilities: "" });

  function load() {
    apiFetch("/seats").then(setSeats).catch((e) => setError(e.message));
    apiFetch("/users").then(setUsers).catch(() => setUsers([])); // admin-only; fine if it fails
  }
  useEffect(() => { setSeats(null); load(); /* eslint-disable-next-line */ }, [activeTenantId]);

  async function create(e) {
    e.preventDefault();
    if (!activeTenantId || !s.title.trim()) return;
    try {
      await apiFetch("/seats", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: s.title,
        parent_seat_id: s.parent_seat_id || null,
        holder_user_id: s.holder_user_id || null,
        responsibilities: s.responsibilities || null,
      })});
      setS({ title: "", parent_seat_id: "", holder_user_id: "", responsibilities: "" });
      load();
    } catch (e) { setError(e.message); }
  }
  async function del(id) {
    if (!confirm("Delete this seat? Seats reporting under it are removed too.")) return;
    try { await apiFetch(`/seats/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  }

  const byParent = seats ? buildTree(seats) : {};

  return (
    <div>
      <h1 className="page-title display">Accountability Chart</h1>
      <p className="page-sub">Who owns which seat in this tenant — and what each seat is accountable for.</p>

      {error && <div className="error-banner">{error}</div>}

      {activeTenantId && (
        <form className="card inline-form" onSubmit={create}>
          <div className="admin-grid">
            <label>Seat title<input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} required placeholder="Visionary" /></label>
            <label>Reports to
              <select value={s.parent_seat_id} onChange={(e) => setS({ ...s, parent_seat_id: e.target.value })}>
                <option value="">Top level (no parent)</option>
                {(seats || []).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            </label>
            <label>Held by
              <select value={s.holder_user_id} onChange={(e) => setS({ ...s, holder_user_id: e.target.value })}>
                <option value="">Vacant</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label>Responsibilities<input value={s.responsibilities} onChange={(e) => setS({ ...s, responsibilities: e.target.value })} placeholder="Vision, culture, big relationships" /></label>
          </div>
          <button className="btn-secondary" type="submit">Add seat</button>
        </form>
      )}

      {!seats && !error && <p className="loading-line">Loading chart…</p>}
      {seats && seats.length === 0 && (
        <div className="empty-state"><p className="display">No seats yet</p><p>Start with a top-level seat (e.g. Visionary), then add seats reporting under it.</p></div>
      )}

      {seats && seats.length > 0 && (
        <div className="seat-tree">
          <SeatNodes nodes={byParent["root"] || []} byParent={byParent} depth={0} onDelete={del} />
        </div>
      )}
    </div>
  );
}
