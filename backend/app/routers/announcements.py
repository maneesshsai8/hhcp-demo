from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_leadership, effective_role, LEADERSHIP_ROLES
from app import outbox, sanitizer, realtime_broadcast

router = APIRouter(prefix="/announcements", tags=["announcements"])


async def _broadcast_nudge(tenant_id, audience, team_id, event, ann_id):
    """Best-effort live nudge for feed interactions (comment / react / ack).
    Server-published and ephemeral: it carries no authoritative state, it just
    tells subscribers to refetch the RLS-guarded feed. Fired AFTER commit, never
    raises (realtime_broadcast is a best-effort transport). Same principle as the
    meeting runner — the client never publishes authoritative state itself."""
    if audience == "team" and team_id:
        ch = realtime_broadcast.team_announcements_channel(str(team_id))
    else:
        ch = realtime_broadcast.tenant_announcements_channel(str(tenant_id))
    await realtime_broadcast.broadcast_to(ch, event, {"announcementId": str(ann_id)})


class NewAnnouncement(BaseModel):
    tenant_id: str
    title: str
    body: str | None = None
    category: str = "general"          # win | news | update | general
    audience: str = "tenant"           # tenant | team
    team_id: str | None = None
    pinned: bool = False
    requires_ack: bool = False
    priority: str = "normal"           # normal | high
    body_format: str = "html"          # html | markdown | plain
    publish_at: str | None = None      # ISO datetime; future → scheduled post


class UpdateAnnouncement(BaseModel):
    title: str | None = None
    body: str | None = None
    category: str | None = None
    pinned: bool | None = None
    requires_ack: bool | None = None
    priority: str | None = None
    archived: bool | None = None       # true → status='archived'


class CommentRequest(BaseModel):
    body: str


class ReactRequest(BaseModel):
    emoji: str


async def _audience_size(conn, tenant_id, audience, team_id) -> int:
    """Cheap COUNT of who this post will reach — for immediate UX only. The
    authoritative recipient set is snapshotted by the worker into
    announcement_recipients (docs §4); this never fans anything out."""
    if audience == "team" and team_id:
        return await conn.fetchval(
            "SELECT count(*) FROM team_members WHERE team_id = $1", team_id) or 0
    return await conn.fetchval(
        "SELECT count(DISTINCT user_id) FROM tenant_memberships WHERE tenant_id = $1", tenant_id) or 0


@router.get("")
async def list_announcements(
    tenant_id: str | None = Query(default=None),
    q: str | None = Query(default=None),           # full-text keyword search (title/body)
    category: str | None = Query(default=None),
    since: str | None = Query(default=None),        # ISO date lower bound
    current_user: CurrentUser = Depends(get_current_user),
):
    """The feed / searchable archive — pinned first, then newest. Published posts
    only, plus the caller's own scheduled ones. Search is GIN full-text with a
    trigram title fallback for partial words."""
    target = tenant_id or current_user.active_tenant_id
    me = current_user.user_id
    async with get_scoped_connection(me) as conn:
        is_fund_admin = await conn.fetchval("SELECT COALESCE(is_fund_admin,false) FROM users WHERE id=$1", me)
        my_teams = [r["team_id"] for r in await conn.fetch("SELECT team_id FROM team_members WHERE user_id=$1", me)]
        rows = await conn.fetch(
            """
            SELECT a.id, a.title, a.body, a.category, a.audience, a.team_id, a.pinned,
                   a.requires_ack, a.priority, a.body_format, a.status, a.publish_at,
                   a.created_at, a.author_id, a.tenant_id,
                   u.name AS author_name, t.name AS team_name,
                   (SELECT count(*) FROM announcement_comments c WHERE c.announcement_id=a.id) AS comment_count,
                   (SELECT count(*) FROM announcement_recipients ar WHERE ar.announcement_id=a.id) AS recipients,
                   (SELECT count(*) FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.ack_at IS NOT NULL) AS ack_count,
                   (SELECT read_at FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=$2) AS my_read_at,
                   (SELECT ack_at  FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=$2) AS my_ack_at
            FROM announcements a
            LEFT JOIN users u ON u.id=a.author_id
            LEFT JOIN teams t ON t.id=a.team_id
            WHERE ($1::uuid IS NULL OR a.tenant_id=$1::uuid)
              AND ($3::text IS NULL OR a.category=$3::text)
              AND ($4::text IS NULL
                   OR a.search_tsv @@ websearch_to_tsquery('english', $4)
                   OR a.title ILIKE '%'||$4||'%')
              AND ($5::timestamptz IS NULL OR a.created_at >= $5::timestamptz)
              AND (a.status='published' OR (a.status='scheduled' AND (a.author_id=$2 OR $6)))
              AND (a.audience='tenant' OR a.author_id=$2 OR $6 OR a.team_id = ANY($7::uuid[]))
            ORDER BY a.pinned DESC, a.created_at DESC
            """,
            target, me, category, q, since, is_fund_admin, my_teams or ["00000000-0000-0000-0000-000000000000"],
        )
        ann_ids = [r["id"] for r in rows]
        reacts = await conn.fetch(
            """SELECT announcement_id, emoji, count(*) AS n,
                      bool_or(user_id=$2) AS mine
               FROM announcement_reactions WHERE announcement_id = ANY($1::uuid[])
               GROUP BY announcement_id, emoji""",
            ann_ids or ["00000000-0000-0000-0000-000000000000"], me,
        ) if ann_ids else []

    by_ann = {}
    for r in reacts:
        by_ann.setdefault(str(r["announcement_id"]), []).append(
            {"emoji": r["emoji"], "count": r["n"], "mine": r["mine"]})

    out = []
    for r in rows:
        d = dict(r)
        recips = d["recipients"] or 0
        d["ack_pct"] = round((d["ack_count"] or 0) / recips * 100) if recips else 0
        d["reactions"] = by_ann.get(str(r["id"]), [])
        out.append(d)
    return out


def _parse_dt(publish_at: str | None) -> datetime | None:
    """Parse an ISO datetime to a tz-aware datetime (asyncpg needs a datetime,
    not a string, for a TIMESTAMPTZ param). None/blank → None."""
    if not publish_at:
        return None
    try:
        dt = datetime.fromisoformat(publish_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail="publish_at must be an ISO datetime")
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.post("")
async def create_announcement(
    body: NewAnnouncement,
    current_user: CurrentUser = Depends(get_current_user),
):
    """Post an announcement. Company-wide (audience=tenant) is leadership-only;
    team-level is open to anyone who can create. The request path ONLY writes the
    row + one outbox event, atomically — the worker fans out deliveries, email,
    and realtime after commit (docs/ANNOUNCEMENTS-ARCHITECTURE.md §5). A future
    `publish_at` parks it as 'scheduled'; pg_cron publishes it when due."""
    publish_dt = _parse_dt(body.publish_at)
    scheduled = publish_dt is not None and publish_dt > datetime.now(timezone.utc)
    clean_body = sanitizer.sanitize_html(body.body) if body.body_format == "html" else body.body

    async with get_scoped_connection(current_user.user_id) as conn:
        if body.audience == "tenant":
            await require_leadership(conn, current_user.user_id, body.tenant_id)
        else:
            await require_permission(conn, current_user.user_id, body.tenant_id, "create")

        row = await conn.fetchrow(
            """INSERT INTO announcements
                   (tenant_id, author_id, title, body, category, audience, team_id,
                    pinned, requires_ack, priority, body_format, status, publish_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id""",
            body.tenant_id, current_user.user_id, body.title, clean_body, body.category,
            body.audience, body.team_id if body.audience == "team" else None,
            body.pinned, body.requires_ack, body.priority, body.body_format,
            "scheduled" if scheduled else "published",
            publish_dt if scheduled else None)
        ann_id = str(row["id"])

        # Estimate reach for the UI now; the worker snapshots the real set later.
        est = await _audience_size(conn, body.tenant_id, body.audience, body.team_id)

        # Publish now → emit the fan-out event in THIS transaction (durable with
        # the row). Scheduled → the pg_cron job (migration 33) emits it when due.
        if not scheduled:
            await outbox.emit(
                conn, "announcement.published", aggregate_id=ann_id,
                tenant_id=body.tenant_id, aggregate_type="announcement",
                payload={"announcementId": ann_id, "tenantId": body.tenant_id,
                         "actorId": current_user.user_id})

    return {"id": ann_id, "status": "scheduled" if scheduled else "published",
            "estimated_recipients": est,
            "scheduled_for": body.publish_at if scheduled else None}


@router.patch("/{ann_id}")
async def update_announcement(ann_id: str, body: UpdateAnnouncement, current_user: CurrentUser = Depends(get_current_user)):
    """Edit / pin / unpin / archive. Author or leadership."""
    clean_body = sanitizer.sanitize_html(body.body) if body.body is not None else None
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id, author_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Announcement not found or not accessible")
        role = await effective_role(conn, current_user.user_id, str(a["tenant_id"]))
        if a["author_id"] != current_user.user_id and role not in LEADERSHIP_ROLES:
            raise HTTPException(status_code=403, detail="Only the author or leadership can edit this")
        new_status = "archived" if body.archived else None
        row = await conn.fetchrow(
            """UPDATE announcements SET title=COALESCE($2,title), body=COALESCE($3,body),
                   category=COALESCE($4,category), pinned=COALESCE($5,pinned),
                   requires_ack=COALESCE($6,requires_ack), priority=COALESCE($7,priority),
                   status=COALESCE($8,status), updated_at=now()
               WHERE id=$1 RETURNING id, pinned, status""",
            ann_id, body.title, clean_body, body.category, body.pinned,
            body.requires_ack, body.priority, new_status)
        # Nudge open feeds to refetch the edited post.
        await outbox.emit(
            conn, "announcement.updated", aggregate_id=ann_id,
            tenant_id=str(a["tenant_id"]), aggregate_type="announcement",
            payload={"announcementId": ann_id, "tenantId": str(a["tenant_id"]),
                     "actorId": current_user.user_id})
    return dict(row)


@router.delete("/{ann_id}")
async def delete_announcement(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id, author_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found or not accessible")
        role = await effective_role(conn, current_user.user_id, str(a["tenant_id"]))
        if a["author_id"] != current_user.user_id and role not in LEADERSHIP_ROLES:
            raise HTTPException(status_code=403, detail="Only the author or leadership can delete this")
        res = await conn.execute("DELETE FROM announcements WHERE id=$1", ann_id)
    return {"deleted": res}


async def _upsert_receipt(conn, ann_id, tenant_id, user_id, *, ack=False):
    if ack:
        await conn.execute(
            """INSERT INTO announcement_receipts (announcement_id, user_id, tenant_id, read_at, ack_at)
               VALUES ($1,$2,$3, now(), now())
               ON CONFLICT (announcement_id, user_id) DO UPDATE SET ack_at=now(),
                   read_at=COALESCE(announcement_receipts.read_at, now())""",
            ann_id, user_id, tenant_id)
    else:
        await conn.execute(
            """INSERT INTO announcement_receipts (announcement_id, user_id, tenant_id, read_at)
               VALUES ($1,$2,$3, now())
               ON CONFLICT (announcement_id, user_id) DO UPDATE SET read_at=COALESCE(announcement_receipts.read_at, now())""",
            ann_id, user_id, tenant_id)


@router.post("/{ann_id}/read")
async def mark_read(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tid = await conn.fetchval("SELECT tenant_id FROM announcements WHERE id=$1", ann_id)
        if tid is None:
            raise HTTPException(status_code=404, detail="Not found")
        await _upsert_receipt(conn, ann_id, tid, current_user.user_id)
    return {"read": True}


@router.post("/{ann_id}/ack")
async def acknowledge(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id, audience, team_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found")
        await _upsert_receipt(conn, ann_id, a["tenant_id"], current_user.user_id, ack=True)
    # Live-update everyone's feed counts + any open ack tracker.
    await _broadcast_nudge(a["tenant_id"], a["audience"], a["team_id"], "announcement.acked", ann_id)
    return {"acknowledged": True}


@router.post("/{ann_id}/react")
async def react(ann_id: str, body: ReactRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Toggle a reaction emoji for the current user."""
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id, audience, team_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found")
        existing = await conn.fetchval(
            "SELECT 1 FROM announcement_reactions WHERE announcement_id=$1 AND user_id=$2 AND emoji=$3",
            ann_id, current_user.user_id, body.emoji)
        if existing:
            await conn.execute("DELETE FROM announcement_reactions WHERE announcement_id=$1 AND user_id=$2 AND emoji=$3",
                               ann_id, current_user.user_id, body.emoji)
            reacted = False
        else:
            await conn.execute(
                "INSERT INTO announcement_reactions (announcement_id, user_id, tenant_id, emoji) VALUES ($1,$2,$3,$4)",
                ann_id, current_user.user_id, a["tenant_id"], body.emoji)
            reacted = True
    await _broadcast_nudge(a["tenant_id"], a["audience"], a["team_id"], "announcement.reacted", ann_id)
    return {"reacted": reacted}


@router.get("/{ann_id}/comments")
async def list_comments(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """SELECT c.id, c.body, c.created_at, u.name AS author_name
               FROM announcement_comments c LEFT JOIN users u ON u.id=c.user_id
               WHERE c.announcement_id=$1 ORDER BY c.created_at""",
            ann_id)
    return [dict(r) for r in rows]


@router.post("/{ann_id}/comments")
async def add_comment(ann_id: str, body: CommentRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id, audience, team_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found")
        row = await conn.fetchrow(
            "INSERT INTO announcement_comments (announcement_id, tenant_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id",
            ann_id, a["tenant_id"], current_user.user_id, body.body)
    await _broadcast_nudge(a["tenant_id"], a["audience"], a["team_id"], "announcement.commented", ann_id)
    return {"id": str(row["id"])}


@router.get("/{ann_id}/acks")
async def ack_tracker(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Acknowledgment tracker — who's acknowledged + completion %. Leadership only.
    The denominator is the explicit recipient snapshot (announcement_recipients),
    NOT the delivery log, so the completion % is stable and auditable (docs §4).
    Until the worker has processed the publish event the snapshot may be empty."""
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found")
        await require_leadership(conn, current_user.user_id, str(a["tenant_id"]))
        recips = await conn.fetch(
            """SELECT u.name, r.read_at, r.ack_at
               FROM announcement_recipients ar
               JOIN users u ON u.id=ar.user_id
               LEFT JOIN announcement_receipts r ON r.announcement_id=ar.announcement_id AND r.user_id=ar.user_id
               WHERE ar.announcement_id=$1
               ORDER BY (r.ack_at IS NULL), u.name""",
            ann_id)
    rows = [dict(r) for r in recips]
    total = len(rows)
    acked = sum(1 for r in rows if r["ack_at"])
    return {"total": total, "acknowledged": acked,
            "completion_pct": round(acked / total * 100) if total else 0, "recipients": rows}


@router.get("/{ann_id}/deliveries")
async def delivery_report(ann_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Per-channel delivery report (sent / failed / queued). Leadership only."""
    async with get_scoped_connection(current_user.user_id) as conn:
        a = await conn.fetchrow("SELECT tenant_id FROM announcements WHERE id=$1", ann_id)
        if a is None:
            raise HTTPException(status_code=404, detail="Not found")
        await require_leadership(conn, current_user.user_id, str(a["tenant_id"]))
        rows = await conn.fetch(
            """SELECT channel, status, count(*) AS n
               FROM notification_deliveries WHERE announcement_id=$1
               GROUP BY channel, status ORDER BY channel, status""",
            ann_id)
    return [dict(r) for r in rows]
