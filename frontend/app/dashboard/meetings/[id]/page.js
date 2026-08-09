"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { realtime } from "@/lib/supabase";
import { authorizeRealtime, meetingChannel } from "@/lib/realtime";
import { useAuth } from "@/lib/auth-context";
import CreateDrawer from "@/components/CreateDrawer";

const CREATE_TYPE_FOR_KIND = { scorecard: "measurable", rocks: "rock", todos: "todo", issues: "issue" };
const KIND_FOR_CREATE_TYPE = { measurable: "scorecard", rock: "rocks", todo: "todos", issue: "issues" };

function clock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtDuration(s) {
  if (s == null) return "—";
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60), sec = s % 60;
  return sec ? `${m} min ${sec} sec` : `${m} min`;
}
const initials = (n) => (n || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();
const ROCK_STATUS = { on_track: { label: "On-track", cls: "on" }, off_track: { label: "Off-track", cls: "off" }, complete: { label: "Complete", cls: "done" } };

// Compact editable status pill for Rocks inside the live meeting (styled like
// the Rocks page; no native select — reuses .status-pill / .status-menu).
function RockStatusPill({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const sm = ROCK_STATUS[value] || ROCK_STATUS.on_track;
  return (
    <span className="status-pill-wrap">
      <button type="button" className={`status-pill ${sm.cls}`} onClick={() => setOpen((o) => !o)}>
        <span className="status-dot" /><span className="status-label">{sm.label}</span>
        <svg className="status-caret" width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <>
          <div className="status-menu-back" onClick={() => setOpen(false)} />
          <div className="status-menu right">
            {Object.entries(ROCK_STATUS).map(([k, m]) => (
              <button key={k} type="button" className={`${m.cls} ${k === value ? "sel" : ""}`} onClick={() => { onChange(k); setOpen(false); }}>
                <span className="status-dot" />{m.label}{k === value && <span className="status-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/* Live data embedded in a section. `refetchKey` bumps to force a reload when a
   participant broadcasts a change. `onChanged` lets in-meeting edits notify the room. */
function SectionData({ kind, tenantId, refetchKey, onChanged }) {
  const [rows, setRows] = useState(null);
  const [newIssue, setNewIssue] = useState("");
  const path = { scorecard: "/scorecards", rocks: "/rocks", todos: "/todos", issues: "/issues", vcbs: "/vcbs" }[kind];

  const load = useCallback(() => {
    if (!path || !tenantId) return;
    // scope to THIS meeting's tenant so we show the right PortCo's items
    // (an admin's /rocks etc. would otherwise span every tenant).
    apiFetch(`${path}?tenant_id=${tenantId}`).then(setRows).catch(() => setRows([]));
  }, [path, tenantId]);
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
  if (kind === "rocks") {
    async function setStatus(r, status) {
      await apiFetch(`/rocks/${r.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      load(); onChanged?.("rocks");
    }
    return rows.length ? rows.map((r) => (
      <div className="run-line" key={r.id}>
        <span className="run-line-main">{r.title}{r.owner_name ? <span className="card-meta"> · {r.owner_name}</span> : ""}</span>
        <RockStatusPill value={r.status} onChange={(s) => setStatus(r, s)} />
      </div>
    )) : <p className="card-meta">No Rocks.</p>;
  }

  if (kind === "vcbs") return rows.length ? rows.map((v) => (
    <div className="run-line" key={v.id}>
      <span>{v.title}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="progress-track" style={{ width: 120 }}><span className="progress-fill" style={{ width: `${v.progress_pct}%` }} /></span>
        <span className={`badge ${v.derived_status || ""}`}>{v.progress_pct}%</span>
      </span>
    </div>
  )) : <p className="card-meta">No Value Creation Blueprints for this PortCo.</p>;

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

/* ---- Post-meeting summary (shown when a meeting is completed) [AC4] ---- */
function MeetingSummary({ meeting, router }) {
  const s = meeting.summary || {};
  const att = meeting.attendance || [];
  return (
    <div style={{ padding: 28, maxWidth: 820, margin: "0 auto" }}>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display" style={{ margin: 0 }}>{meeting.title}</h1>
          <p className="page-sub">
            Meeting summary · {fmtDuration(s.duration_seconds)}
            {meeting.ended_at ? ` · ${new Date(meeting.ended_at).toLocaleString()}` : ""}
            {meeting.team_name ? ` · ${meeting.team_name}` : ""}
          </p>
        </div>
        <div className="head-actions"><button className="btn-ghost" onClick={() => router.push("/dashboard/meetings")}>← Back to meetings</button></div>
      </div>

      <div className="stat-row" style={{ marginBottom: 16 }}>
        <div className="stat-card"><span className="stat-num">{s.rating != null ? s.rating : "—"}</span><span className="stat-label">Rating (1–10)</span></div>
        <div className="stat-card"><span className="stat-num">{s.attendance ?? att.length}</span><span className="stat-label">Attended</span></div>
        <div className="stat-card"><span className="stat-num">{(s.issues_raised || []).length}</span><span className="stat-label">Issues raised</span></div>
        <div className="stat-card"><span className="stat-num">{s.issues_solved ?? 0}</span><span className="stat-label">Issues solved</span></div>
        <div className="stat-card"><span className="stat-num">{(s.todos_created || []).length}</span><span className="stat-label">To-Dos created</span></div>
      </div>

      {att.length > 0 && (
        <div className="card">
          <p className="card-title">Attendance</p>
          <div className="att-avatars">
            {att.map((u) => <span key={u.id} className="att-av here" title={u.name}>{initials(u.name)}</span>)}
          </div>
          <p className="card-meta">{att.map((u) => u.name).join(", ")}</p>
        </div>
      )}

      <div className="card">
        <p className="card-title">To-Dos created this meeting</p>
        {(s.todos_created || []).length
          ? (s.todos_created || []).map((t, i) => <div className="run-line" key={i}><span>○ {t}</span></div>)
          : <p className="card-meta">None.</p>}
      </div>

      <div className="card">
        <p className="card-title">Issues raised</p>
        {(s.issues_raised || []).length
          ? (s.issues_raised || []).map((t, i) => <div className="run-line" key={i}><span>{t}</span></div>)
          : <p className="card-meta">None.</p>}
      </div>

      {s.notes && <div className="card"><p className="card-title">Notes</p><p className="ann-body">{s.notes}</p></div>}
    </div>
  );
}

export default function MeetingRunner() {
  const { id } = useParams();
  const router = useRouter();
  const [meeting, setMeeting] = useState(null);
  const [error, setError] = useState("");
  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [secElapsed, setSecElapsed] = useState(0);     // time on the current section
  const [present, setPresent] = useState([]);          // live participants (Realtime Presence)
  const [refetch, setRefetch] = useState({});          // {issues: n, todos: n, ...}
  const [rating, setRating] = useState(8);
  const [notes, setNotes] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [overtime, setOvertime] = useState(false);
  const [canEdit, setCanEdit] = useState(true);        // facilitator? from /live-state
  const startRef = useRef(null);
  const secStartRef = useRef(Date.now());
  const alertedRef = useRef(false);
  const audioRef = useRef(null);
  const chRef = useRef(null);
  const refetchTimer = useRef(null);
  const { user, can } = useAuth();

  useEffect(() => {
    apiFetch(`/meetings/${id}`).then((m) => {
      setMeeting(m);
      startRef.current = m.started_at ? new Date(m.started_at).getTime() : Date.now();
    }).catch((e) => setError(e.message));
  }, [id]);

  // Authoritative state recovery: (re)fetch /live-state and replace stale local
  // state. Called on mount, on every confirmed Realtime event, and on reconnect.
  const syncLiveState = useCallback(() => {
    apiFetch(`/meetings/${id}/live-state`).then((ls) => {
      if (typeof ls.current_section_index === "number") setIdx(ls.current_section_index);
      setCanEdit(!!ls.permissions?.can_edit);
      setMeeting((m) => (m ? { ...m, status: ls.status } : m));
    }).catch(() => {});
  }, [id]);
  const scheduleSync = useCallback(() => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(syncLiveState, 250);   // debounce bursts
  }, [syncLiveState]);

  // ---- Supabase Realtime: Presence (who's connected) + Broadcast (confirmed
  // events published by the SERVER). Clients never broadcast authoritative
  // state; a broadcast just tells us to refetch the RLS-guarded live-state. ----
  const tenantId = meeting?.tenant_id;
  useEffect(() => {
    if (!realtime || !id || !user || !tenantId) return;
    if (meeting && meeting.status === "completed") return;   // no live layer once finished
    const me = { id: user.id, name: user.name || "User" };
    let ch, cancelled = false;

    (async () => {
      await authorizeRealtime();                               // mint + apply the tenant-scoped token
      if (cancelled) return;
      ch = realtime.channel(meetingChannel(tenantId, id), { config: { private: true, presence: { key: me.id } } });
      chRef.current = ch;

      ch.on("presence", { event: "sync" }, () => {
        const state = ch.presenceState();
        const seen = {};
        Object.values(state).flat().forEach((p) => { if (p.id) seen[p.id] = p.name; });
        setPresent(Object.entries(seen).map(([id2, name]) => ({ id: id2, name })));
      });
      ch.on("broadcast", { event: "*" }, (msg) => {
        const ev = msg.event || "";
        if (ev === "nudge" || ev === "segment.updated") {
          const what = msg.payload?.what;
          if (what) setRefetch((r) => ({ ...r, [what]: (r[what] || 0) + 1 }));
        }
        if (ev === "meeting.completed" || ev === "summary.generated") {
          apiFetch(`/meetings/${id}`).then(setMeeting).catch(() => {});
          return;
        }
        scheduleSync();   // any confirmed event → reconcile against the server
      });
      ch.subscribe((status) => {
        const on = status === "SUBSCRIBED";
        setLive(on);
        if (on) { ch.track(me); syncLiveState(); }
        // token expired / not yet authorized → re-mint; supabase rejoins with it
        else if (status === "CHANNEL_ERROR") authorizeRealtime(true);
      });
    })();

    return () => { cancelled = true; try { if (ch) realtime.removeChannel(ch); } catch {} chRef.current = null; };
  }, [id, user, tenantId, meeting?.status, scheduleSync, syncLiveState]);

  useEffect(() => {
    const t = setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      setSecElapsed(Math.floor((Date.now() - secStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // reset the section clock whenever the active section changes
  useEffect(() => { secStartRef.current = Date.now(); setSecElapsed(0); setOvertime(false); alertedRef.current = false; }, [idx]);

  // audible + visual alert when a section runs over its allotted minutes [AC2]
  const sections = meeting?.sections || [];
  const cur = sections[idx];
  const secLimit = cur?.minutes ? cur.minutes * 60 : null;
  useEffect(() => {
    if (secLimit && secElapsed >= secLimit && !alertedRef.current) {
      alertedRef.current = true;
      setOvertime(true);
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ctx = audioRef.current || (audioRef.current = new AC());
          [0, 300, 600].forEach((delay) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
            const t0 = ctx.currentTime + delay / 1000;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
            o.start(t0); o.stop(t0 + 0.2);
          });
        }
      } catch {}
    }
  }, [secElapsed, secLimit]);

  // Facilitator advances the room: persist the segment on the server (which
  // emits segment.changed → the worker broadcasts → everyone refetches). Local
  // idx is set optimistically for instant feedback.
  const goSection = (i) => {
    setIdx(i);
    // A rejected write (e.g. a 409 if the server state moved) is not an error to
    // show — just reconcile against the authoritative /live-state.
    if (canEdit) apiFetch(`/meetings/${id}/current-section`, { method: "POST", body: JSON.stringify({ index: i }) }).catch(() => scheduleSync());
  };
  // Lightweight, non-authoritative "please refresh this list" hint to the room.
  const broadcastChange = (what) => {
    try { chRef.current?.send({ type: "broadcast", event: "nudge", payload: { what } }); } catch {}
    setRefetch((r) => ({ ...r, [what]: (r[what] || 0) + 1 }));
  };

  if (error) return (
    <div style={{ padding: 28 }}>
      <div className="error-banner">Couldn&rsquo;t open this meeting: {error}</div>
      <button className="mod-ghost" style={{ marginTop: 14 }} onClick={() => router.push("/dashboard/meetings")}>← Back to meetings</button>
    </div>
  );
  if (!meeting) return (
    <div style={{ padding: 28 }}>
      <p className="loading-line">Loading meeting…</p>
      <p className="page-sub" style={{ marginTop: 10 }}>
        Stuck on this screen? The app was updated — hard-refresh with <b>Cmd/Ctrl + Shift + R</b>, or{" "}
        <button className="linklike" onClick={() => router.push("/dashboard/meetings")}>go back to meetings</button>.
      </p>
    </div>
  );
  if (meeting.status === "completed") return <MeetingSummary meeting={meeting} router={router} />;

  const roster = meeting.roster || [];
  const presentIds = new Set(present.map((p) => p.id));

  async function finish() {
    try {
      // persist who was present (live presence set, falling back to the full roster)
      const attendee_ids = present.length ? present.map((p) => p.id) : roster.map((u) => u.id);
      await apiFetch(`/meetings/${id}/finish`, { method: "POST", body: JSON.stringify({ rating, notes: notes || null, attendee_ids }) });
      router.push("/dashboard/meetings");
    } catch (e) { setError(e.message); }
  }
  // pause / resume / cancel drive the server state machine; the worker broadcasts
  // the transition and every client reconciles via /live-state.
  async function lifecycle(action) {
    try {
      const r = await apiFetch(`/meetings/${id}/${action}`, { method: "POST", body: JSON.stringify({}) });
      setMeeting((m) => (m ? { ...m, status: r.status } : m));
      if (action === "cancel") router.push("/dashboard/meetings");
    } catch (e) {
      // A 409 here means the meeting's state already moved (another action/event
      // raced this one). Don't take over the page with an error — just reconcile
      // to the true server state so the controls reflect reality.
      if (/\b409\b/.test(e.message) || /state/i.test(e.message)) syncLiveState();
      else setError(e.message);
    }
  }
  const paused = meeting.status === "paused";

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
        {canEdit && (
          <div className="runner-lifecycle">
            {paused
              ? <button className="btn-ghost" onClick={() => lifecycle("resume")}>▶ Resume</button>
              : <button className="btn-ghost" onClick={() => lifecycle("pause")}>⏸ Pause</button>}
            <button className="link-danger" onClick={() => { if (confirm("Cancel this meeting? It won't be completed.")) lifecycle("cancel"); }}>Cancel</button>
          </div>
        )}
        <button className="btn-secondary runner-finish" onClick={finish}>Finish Meeting</button>
      </aside>

      <div className="runner-main">
        <CreateDrawer
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          tenantId={meeting.tenant_id}
          initialType={CREATE_TYPE_FOR_KIND[cur?.kind] || "issue"}
          onCreated={(t) => broadcastChange(KIND_FOR_CREATE_TYPE[t] || "issues")}
        />
        {paused && <div className="ok-banner" style={{ background: "#fff8e6", color: "#9a6b00", borderColor: "#e0a100" }}>⏸ Meeting paused — timers are held. Resume to continue.</div>}
        <div className="runner-head">
          <h1 className="page-title display" style={{ margin: 0 }}>{cur?.label} <span className="runner-agenda">· {meeting.title}</span></h1>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {can("create") && <button className="mod-create" onClick={() => setCreateOpen(true)}>+ Create</button>}
            {/* per-section timer with overtime alert */}
            {secLimit && (
              <div className={`sec-timer ${overtime ? "over" : secElapsed >= secLimit * 0.8 ? "warn" : ""}`} title={overtime ? "Over the allotted time — wrap up" : ""}>
                <span className="sec-timer-time">{clock(secElapsed)}</span>
                <span className="sec-timer-limit">/ {cur.minutes}:00</span>
                {overtime && <span className="sec-timer-flag">⏰ over time</span>}
              </div>
            )}
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
        </div>

        {cur && (
          <div className={`card ${overtime ? "card-overtime" : ""}`}>
            <p className="run-prompt">{cur.prompt}</p>
            {cur.kind === "segue" && (
              <p className="card-meta">Everyone shares their good news. Attendance updates live above as teammates join.</p>
            )}
            {["scorecard", "rocks", "todos", "issues", "vcbs"].includes(cur.kind) &&
              <SectionData key={cur.key} kind={cur.kind} tenantId={meeting.tenant_id} refetchKey={refetch[cur.kind] || 0} onChanged={broadcastChange} />}
            {cur.kind === "text" && <textarea className="notes-box" placeholder="Notes…" value={notes} onChange={(e) => setNotes(e.target.value)} />}
            {cur.kind === "conclude" && (
              <>
                <label className="fld" style={{ maxWidth: 260 }}>Rate this meeting (1–10)
                  <input type="number" min="1" max="10" step="0.5" value={rating} onChange={(e) => setRating(Number(e.target.value))} />
                </label>
                <label className="fld">Closing notes / cascading messages
                  <textarea className="notes-box" placeholder="Recap and cascading messages…" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
              </>
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
