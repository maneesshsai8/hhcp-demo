"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { realtime } from "@/lib/supabase";

const LEADERSHIP = new Set(["fund_admin", "lead_partner", "deal_qb", "portco_management"]);
const CATEGORIES = ["general", "win", "news", "update"];
const CAT_LABEL = { general: "General", win: "Customer win", news: "Employee news", update: "Company update" };
const EMOJIS = ["👍", "🎉", "❤️", "👏"];
const BLANK = { title: "", body: "", category: "general", audience: "tenant", team_id: "", pinned: false, requires_ack: false, priority: "normal", publish_at: "" };

export default function AnnouncementsPage() {
  const { activeTenantId, activeRole, user, can } = useAuth();
  const [items, setItems] = useState(null);
  const [teams, setTeams] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [show, setShow] = useState(false);
  const [f, setF] = useState(BLANK);
  const [openComments, setOpenComments] = useState(null);
  const [comments, setComments] = useState([]);
  const [cDraft, setCDraft] = useState("");
  const [tracker, setTracker] = useState(null);   // {id, data}

  // Refs so the realtime handler can see the currently-open thread/tracker
  // without re-subscribing every time they change.
  const openCommentsRef = useRef(openComments);
  useEffect(() => { openCommentsRef.current = openComments; }, [openComments]);
  const trackerIdRef = useRef(tracker?.id);
  useEffect(() => { trackerIdRef.current = tracker?.id; }, [tracker]);

  const isLeader = !!user?.is_fund_admin || LEADERSHIP.has(activeRole);
  const canPost = isLeader || can("create");        // managers can post team-level

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (cat) p.set("category", cat);
    apiFetch(`/announcements?${p.toString()}`).then((rows) => {
      setItems(rows);
      // in-app read receipts: mark anything unread as read
      rows.filter((r) => !r.my_read_at).forEach((r) => apiFetch(`/announcements/${r.id}/read`, { method: "POST" }).catch(() => {}));
    }).catch((e) => setError(e.message));
  }, [q, cat]);

  useEffect(() => { setItems(null); load(); apiFetch(`/teams${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setTeams).catch(() => {}); /* eslint-disable-next-line */ }, [activeTenantId, load]);

  // Live feed: the SERVER (outbox worker) broadcasts announcement.published /
  // .updated to the tenant channel (and per-team channels for team posts) AFTER
  // commit. We only refetch the RLS-guarded feed on a nudge — never trust the
  // broadcast payload as the source of truth. Same contract as the meeting runner.
  useEffect(() => {
    if (!realtime || !activeTenantId) return;
    const channels = [realtime.channel(`tenant:${activeTenantId}:announcements`)];
    teams.forEach((t) => channels.push(realtime.channel(`team:${t.id}:announcements`)));
    const onNudge = (msg) => {
      const aid = msg?.payload?.announcementId;
      load();   // feed counts: comment_count, reactions, ack %, read state
      // Refetch the open comment thread / ack tracker if this post is the one that changed.
      if (aid && openCommentsRef.current === aid) apiFetch(`/announcements/${aid}/comments`).then(setComments).catch(() => {});
      if (aid && trackerIdRef.current === aid) apiFetch(`/announcements/${aid}/acks`).then((data) => setTracker({ id: aid, data })).catch(() => {});
    };
    channels.forEach((ch) => { ch.on("broadcast", { event: "*" }, onNudge); ch.subscribe(); });
    return () => channels.forEach((ch) => { try { realtime.removeChannel(ch); } catch {} });
  }, [activeTenantId, teams, load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };

  async function post(e) {
    e.preventDefault();
    if (!activeTenantId || !f.title.trim()) return;
    try {
      const r = await apiFetch("/announcements", { method: "POST", body: JSON.stringify({
        tenant_id: activeTenantId, title: f.title, body: f.body || null, category: f.category,
        audience: f.audience, team_id: f.audience === "team" ? (f.team_id || null) : null,
        pinned: f.pinned, requires_ack: f.requires_ack, priority: f.priority,
        body_format: "plain",   // plain textarea today; switch to 'html' with a rich editor
        publish_at: f.publish_at ? new Date(f.publish_at).toISOString() : null,
      })});
      setF(BLANK); setShow(false);
      flash(r.status === "scheduled"
        ? `Scheduled for ${new Date(r.scheduled_for).toLocaleString()} · ~${r.estimated_recipients} recipient(s).`
        : `Posted · delivering to ~${r.estimated_recipients} recipient(s) (email viewable at :54324).`);
      load();
    } catch (e) { setError(e.message); }
  }
  async function ack(id) { try { await apiFetch(`/announcements/${id}/ack`, { method: "POST" }); load(); } catch (e) { setError(e.message); } }
  async function react(id, emoji) { try { await apiFetch(`/announcements/${id}/react`, { method: "POST", body: JSON.stringify({ emoji }) }); load(); } catch (e) { setError(e.message); } }
  async function togglePin(a) { try { await apiFetch(`/announcements/${a.id}`, { method: "PATCH", body: JSON.stringify({ pinned: !a.pinned }) }); load(); } catch (e) { setError(e.message); } }
  async function del(id) { if (!confirm("Delete this announcement?")) return; try { await apiFetch(`/announcements/${id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); } }

  async function toggleComments(id) {
    if (openComments === id) { setOpenComments(null); return; }
    setOpenComments(id); setComments([]);
    try { setComments(await apiFetch(`/announcements/${id}/comments`)); } catch (e) { setError(e.message); }
  }
  async function addComment(id) {
    if (!cDraft.trim()) return;
    try { await apiFetch(`/announcements/${id}/comments`, { method: "POST", body: JSON.stringify({ body: cDraft }) });
      setCDraft(""); setComments(await apiFetch(`/announcements/${id}/comments`)); load(); } catch (e) { setError(e.message); }
  }
  async function openTracker(id) {
    try { setTracker({ id, data: await apiFetch(`/announcements/${id}/acks`) }); } catch (e) { setError(e.message); }
  }

  const pinned = (items || []).filter((a) => a.pinned);
  const rest = (items || []).filter((a) => !a.pinned);

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title display">Announcements</h1>
          <p className="page-sub">Company and team headlines, wins, and updates — with read receipts and acknowledgments.</p>
        </div>
        {activeTenantId && canPost && <div className="head-actions"><button className="btn-secondary" onClick={() => { setF(BLANK); setShow((s) => !s); }}>{show ? "Cancel" : "+ New announcement"}</button></div>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      {show && (
        <form className="card inline-form" onSubmit={post}>
          <label className="fld">Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required placeholder="Customer win: closed the Dayco renewal 🎉" /></label>
          <label className="fld">Message<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="Share the details…" /></label>
          <div className="fld-row-3">
            <label className="fld">Category
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
              </select>
            </label>
            <label className="fld">Audience
              <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
                <option value="tenant" disabled={!isLeader}>Company-wide{!isLeader ? " (leadership only)" : ""}</option>
                <option value="team">Specific team</option>
              </select>
            </label>
            {f.audience === "team" && (
              <label className="fld">Team
                <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })} required>
                  <option value="">Select team…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="fld-row-3">
            <label className="fld">Priority
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                <option value="normal">Normal</option>
                <option value="high">High (banner)</option>
              </select>
            </label>
            <label className="fld">Schedule for later<input type="datetime-local" value={f.publish_at} onChange={(e) => setF({ ...f, publish_at: e.target.value })} /></label>
          </div>
          <div className="gwc-edit">
            <label className="fld-check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to top</label>
            <label className="fld-check"><input type="checkbox" checked={f.requires_ack} onChange={(e) => setF({ ...f, requires_ack: e.target.checked })} /> Require acknowledgment</label>
          </div>
          <button className="btn-secondary" type="submit">{f.publish_at ? "Schedule announcement" : "Post announcement"}</button>
        </form>
      )}

      <div className="filter-bar">
        <input className="mini-input" style={{ minWidth: 220 }} placeholder="Search announcements…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="mini-input" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
        </select>
      </div>

      {!items && !error && <p className="loading-line">Loading feed…</p>}
      {items && items.length === 0 && <div className="empty-state"><p className="display">No announcements</p><p>{canPost ? "Post the first headline above." : "Nothing posted here yet."}</p></div>}

      {pinned.length > 0 && <p className="mini-label" style={{ marginTop: 8 }}>📌 Pinned</p>}
      {[...pinned, ...(pinned.length ? [{ _divider: true }] : []), ...rest].map((a, i) => a._divider
        ? <hr key="div" className="ann-divider" />
        : <AnnCard key={a.id} a={a} isLeader={isLeader} me={user}
            onAck={ack} onReact={react} onPin={togglePin} onDel={del}
            onComments={toggleComments} commentsOpen={openComments === a.id} comments={comments}
            cDraft={cDraft} setCDraft={setCDraft} onAddComment={addComment} onTracker={openTracker} />
      )}

      {tracker && (
        <div className="modal-backdrop" onClick={() => setTracker(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p className="card-title">Acknowledgment tracker</p>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${tracker.data.completion_pct}%` }} /></div>
            <p className="card-meta">{tracker.data.acknowledged}/{tracker.data.total} acknowledged · {tracker.data.completion_pct}%</p>
            <table className="admin-table"><thead><tr><th>Person</th><th>Read</th><th>Acknowledged</th></tr></thead>
              <tbody>{tracker.data.recipients.map((r, i) => (
                <tr key={i}><td>{r.name}</td><td>{r.read_at ? "✓" : "—"}</td><td>{r.ack_at ? "✓" : "—"}</td></tr>
              ))}</tbody></table>
            <div className="card-actions"><button className="btn-mini" onClick={() => setTracker(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnnCard({ a, isLeader, me, onAck, onReact, onPin, onDel, onComments, commentsOpen, comments, cDraft, setCDraft, onAddComment, onTracker }) {
  const mine = a.author_id === me?.id;
  return (
    <div className="card ann-card">
      <div className="card-row">
        <div>
          <p className="card-title">
            {a.pinned && <span className="freq-tag">📌 pinned</span>} <span className={`cat-tag ${a.category}`}>{CAT_LABEL[a.category]}</span> {a.title}
            {a.status === "scheduled" && <span className="ann-req">⏱ scheduled {a.publish_at ? `for ${new Date(a.publish_at).toLocaleString()}` : ""}</span>}
            {a.requires_ack && <span className="ann-req">acknowledgment required</span>}
          </p>
          {a.body && <p className="ann-body">{a.body}</p>}
          <p className="card-meta">
            {a.author_name || "System"} · {new Date(a.created_at).toLocaleString()}
            {a.audience === "team" && a.team_name ? ` · to ${a.team_name}` : " · company-wide"}
          </p>
        </div>
        <div className="card-controls">
          {(isLeader || mine) && <button className="btn-mini ghost" onClick={() => onPin(a)}>{a.pinned ? "Unpin" : "Pin"}</button>}
          {(isLeader || mine) && <button className="link-danger" onClick={() => onDel(a.id)}>Delete</button>}
        </div>
      </div>

      <div className="ann-actions">
        <span className="react-row">
          {EMOJIS.map((e) => {
            const r = (a.reactions || []).find((x) => x.emoji === e);
            return <button key={e} className={`react-btn ${r?.mine ? "mine" : ""}`} onClick={() => onReact(a.id, e)}>{e}{r ? ` ${r.count}` : ""}</button>;
          })}
        </span>
        <button className="link-muted" onClick={() => onComments(a.id)}>💬 {a.comment_count || 0} comment{a.comment_count === 1 ? "" : "s"}</button>
        {a.requires_ack && (a.my_ack_at
          ? <span className="ann-acked">✓ Acknowledged</span>
          : <button className="btn-mini" onClick={() => onAck(a.id)}>Acknowledge</button>)}
        {isLeader && a.requires_ack && <button className="link-muted" onClick={() => onTracker(a.id)}>Ack {a.ack_pct}% ({a.ack_count}/{a.recipients})</button>}
      </div>

      {commentsOpen && (
        <div className="ann-comments">
          {comments.length === 0 && <p className="fld-opt">No comments yet.</p>}
          {comments.map((c) => (
            <div className="ann-comment" key={c.id}><strong>{c.author_name || "?"}</strong> <span className="fld-opt">{new Date(c.created_at).toLocaleString()}</span><p>{c.body}</p></div>
          ))}
          <div className="add-rock-inline" style={{ marginTop: 8 }}>
            <input className="mini-input" placeholder="Add a comment…" value={cDraft} onChange={(e) => setCDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onAddComment(a.id)} />
            <button className="btn-mini" onClick={() => onAddComment(a.id)}>Comment</button>
          </div>
        </div>
      )}
    </div>
  );
}
