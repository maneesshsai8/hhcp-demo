"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch, getStoredAuth, API_BASE } from "@/lib/api";

function clock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
const initials = (n) => (n || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();

/* Live data embedded in a section. `refetchKey` bumps to force a reload when a
   participant broadcasts a change. `onChanged` lets in-meeting edits notify the room. */
function SectionData({ kind, tenantId, refetchKey, onChanged }) {
  const [rows, setRows] = useState(null);
  const [newIssue, setNewIssue] = useState("");
  const path = { scorecard: "/scorecards", rocks: "/rocks", todos: "/todos", issues: "/issues" }[kind];

  const load = useCallback(() => {
    if (!path) return;
    apiFetch(path).then(setRows).catch(() => setRows([]));
  }, [path]);
  useEffect(() => { setRows(null); load(); }, [load, refetchKey]);

  if (!path) return null;
  if (!rows) return <p className="loading-line">Loading…</p>;

  if (kind === "scorecard") return (
    <table className="history-table"><thead><tr><th>KPI</th><th>Owner</th><th>Target</th><th>This week</th></tr></thead>
      <tbody>{rows.map((k) => {
        const latest = k.weekly_history[k.weekly_history.length - 1];
        return <tr key={k.kpi_id}><td>{k.title}</td><td>{k.owner || "—"}</td><td>{k.comparison_operator} {k.target_value} {k.unit}</td>
          <td>{latest ? <span className={`badge ${latest.status === "ON_TRACK" ? "on_track" : "off_track"}`}>{latest.actual_value}</span> : "—"}</td></tr>;
      })}</tbody></table>
  );
  if (kind === "rocks") return rows.length ? rows.map((r) => (
    <div className="run-line" key={r.id}><span>{r.title}</span><span className={`badge ${r.status || ""}`}>{(r.status || "").replace("_", " ")}</span></div>
  )) : <p className="card-meta">No Rocks.</p>;

  if (kind === "todos") {
    async function toggle(t) {
      await apiFetch(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: t.status === "done" ? "open" : "done" }) });
      load(); onChanged?.("todos");
    }
    return rows.length ? rows.map((t) => (
      <div className="run-line clickable" key={t.id} onClick={() => toggle(t)} title="Click to toggle done">
        <span>{t.status === "done" ? "✓ " : "○ "}{t.title}</span><span className="card-meta">{t.owner_name || ""}</span>
      </div>
    )) : <p className="card-meta">No To-Dos.</p>;
  }

  if (kind === "issues") {
    async function addIssue(e) {
      e.preventDefault();
      if (!newIssue.trim()) return;
      await apiFetch("/issues", { method: "POST", body: JSON.stringify({ tenant_id: tenantId, title: newIssue }) });
      setNewIssue(""); load(); onChanged?.("issues");
    }
    async function solve(i) {
      await apiFetch(`/issues/${i.id}`, { method: "PATCH", body: JSON.stringify({ status: i.status === "open" ? "solved" : "open" }) });
      load(); onChanged?.("issues");
    }
    return (
      <>
        <form className="new-item-form" onSubmit={addIssue}>
          <input placeholder="Identify an issue…" value={newIssue} onChange={(e) => setNewIssue(e.target.value)} />
          <button className="btn-secondary" type="submit">Add Issue</button>
        </form>
        {rows.length ? rows.map((i) => (
          <div className="run-line clickable" key={i.id} onClick={() => solve(i)} title="Click to solve/reopen">
            <span>{i.title}</span><span className={`badge ${i.status}`}>{i.status}</span>
          </div>
        )) : <p className="card-meta">No issues — add one above.</p>}
      </>
    );
  }
  return null;
}

export default function MeetingRunner() {
  const { id } = useParams();
  const router = useRouter();
  const [meeting, setMeeting] = useState(null);
  const [error, setError] = useState("");
  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [present, setPresent] = useState([]);          // live participants (WS presence)
  const [refetch, setRefetch] = useState({});          // {issues: n, todos: n, ...}
  const [rating, setRating] = useState(8);
  const [live, setLive] = useState(false);
  const startRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    apiFetch(`/meetings/${id}`).then((m) => {
      setMeeting(m);
      startRef.current = m.started_at ? new Date(m.started_at).getTime() : Date.now();
    }).catch((e) => setError(e.message));
  }, [id]);

  // ---- WebSocket: presence + section follow + refetch relay ----
  useEffect(() => {
    const auth = getStoredAuth();
    if (!auth?.access_token) return;
    const wsUrl = `${API_BASE.replace(/^http/, "ws")}/ws/meetings/${id}?token=${auth.access_token}`;
    let ws, closed = false;
    function connect() {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => setLive(true);
      ws.onclose = () => { setLive(false); if (!closed) setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "presence") setPresent(msg.users);
        else if (msg.type === "section") setIdx(msg.index);
        else if (msg.type === "refetch") setRefetch((r) => ({ ...r, [msg.what]: (r[msg.what] || 0) + 1 }));
      };
    }
    connect();
    return () => { closed = true; try { ws && ws.close(); } catch {} };
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const send = (obj) => { try { wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify(obj)); } catch {} };
  const goSection = (i) => { setIdx(i); send({ type: "section", index: i }); };            // drive the room
  const broadcastChange = (what) => send({ type: "changed", what });

  if (error) return <div style={{ padding: 28 }}><div className="error-banner">{error}</div></div>;
  if (!meeting) return <div style={{ padding: 28 }} className="loading-line">Loading meeting…</div>;

  const sections = meeting.sections || [];
  const cur = sections[idx];
  const roster = meeting.roster || [];
  const presentIds = new Set(present.map((p) => p.id));

  async function finish() {
    try {
      await apiFetch(`/meetings/${id}/finish`, { method: "POST", body: JSON.stringify({ rating }) });
      router.push("/dashboard/meetings");
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="runner">
      <aside className="runner-rail">
        <div className="runner-total">
          <span className="runner-total-label">Total</span>
          <span className="runner-total-time">{clock(elapsed)}</span>
          <span className={`live-dot ${live ? "on" : ""}`}>{live ? "● live" : "○ offline"}</span>
        </div>
        <div className="runner-secs">
          {sections.map((s, i) => (
            <button key={s.key} className={`runner-sec ${i === idx ? "active" : ""} ${i < idx ? "done" : ""}`} onClick={() => goSection(i)}>
              <span className="runner-sec-n">{i + 1}</span>
              <span className="runner-sec-label">{s.label}</span>
              <span className="runner-sec-min">{s.minutes}m</span>
            </button>
          ))}
        </div>
        <button className="btn-secondary runner-finish" onClick={finish}>Finish Meeting</button>
      </aside>

      <div className="runner-main">
        <div className="runner-head">
          <h1 className="page-title display" style={{ margin: 0 }}>{cur?.label} <span className="runner-agenda">· {meeting.title}</span></h1>
          {/* live attendance */}
          <div className="attendance-bar">
            <strong>{present.length} of {roster.length || present.length} present</strong>
            <div className="att-avatars">
              {roster.map((u) => (
                <span key={u.id} className={`att-av ${presentIds.has(u.id) ? "here" : ""}`} title={`${u.name}${presentIds.has(u.id) ? " · present" : ""}`}>{initials(u.name)}</span>
              ))}
            </div>
          </div>
        </div>

        {cur && (
          <div className="card">
            <p className="run-prompt">{cur.prompt}</p>
            {cur.kind === "segue" && (
              <p className="card-meta">Everyone shares their good news. Attendance updates live above as teammates join.</p>
            )}
            {["scorecard", "rocks", "todos", "issues"].includes(cur.kind) &&
              <SectionData key={cur.key} kind={cur.kind} tenantId={meeting.tenant_id} refetchKey={refetch[cur.kind] || 0} onChanged={broadcastChange} />}
            {cur.kind === "text" && <textarea className="notes-box" placeholder="Notes…" />}
            {cur.kind === "conclude" && (
              <label className="fld" style={{ maxWidth: 260 }}>Rate this meeting (1–10)
                <input type="number" min="1" max="10" step="0.5" value={rating} onChange={(e) => setRating(Number(e.target.value))} />
              </label>
            )}
          </div>
        )}

        <div className="runner-controls">
          <button className="btn-ghost" disabled={idx === 0} onClick={() => goSection(Math.max(0, idx - 1))}>← Previous</button>
          {idx < sections.length - 1
            ? <button className="btn-secondary" onClick={() => goSection(idx + 1)}>Next: {sections[idx + 1]?.label} →</button>
            : <button className="btn-secondary" onClick={finish}>Finish Meeting</button>}
        </div>
      </div>
    </div>
  );
}
