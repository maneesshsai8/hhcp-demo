import json
from fastapi import APIRouter, Depends, Query, HTTPException, Header, Request
from pydantic import BaseModel
from datetime import datetime

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission, effective_role
from app import schemas, agendas, audit, outbox, idempotency, meeting_summary

router = APIRouter(prefix="/meetings", tags=["meetings"])

# Explicit meeting state machine. A transition is rejected (409) unless the
# meeting's current status is in the allowed source set for that action.
_ALLOWED_FROM = {
    "start":    {"draft", "scheduled"},
    "pause":    {"in_progress"},
    "resume":   {"paused"},
    "complete": {"in_progress", "paused"},
    "cancel":   {"draft", "scheduled", "in_progress", "paused"},
}


def _assert_transition(action: str, status: str):
    if status not in _ALLOWED_FROM[action]:
        raise HTTPException(status_code=409, detail=f"Cannot {action} a meeting in state '{status}'")


async def _can_edit(conn, user_id: str, tenant_id: str) -> bool:
    try:
        await require_permission(conn, user_id, str(tenant_id), "edit")
        return True
    except HTTPException:
        return False


class NewMeetingRequest(BaseModel):
    tenant_id: str
    title: str
    scheduled_at: datetime | None = None
    notes: str | None = None
    calendar_provider: str | None = None   # 'google' | 'microsoft' → async calendar sync


class UpdateMeetingRequest(BaseModel):
    title: str | None = None
    scheduled_at: datetime | None = None
    notes: str | None = None
    expected_version: int | None = None   # optimistic lock; 409 on mismatch


class LifecycleRequest(BaseModel):
    """Body for pause/resume/cancel (all optional)."""
    expected_version: int | None = None
    reason: str | None = None


class SectionRequest(BaseModel):
    index: int
    expected_version: int | None = None


class RatingRequest(BaseModel):
    rating: float           # 1..10, validated in the handler for a clean 422
    feedback: str | None = None


class StartMeetingRequest(BaseModel):
    tenant_id: str
    agenda_key: str
    team_id: str | None = None


class FinishMeetingRequest(BaseModel):
    rating: float | None = None
    notes: str | None = None
    attendee_ids: list[str] | None = None   # who was present (persisted for the summary)


class TemplateRequest(BaseModel):
    tenant_id: str
    name: str
    sections: list[dict]


def _duration_seconds(row) -> int | None:
    if row.get("started_at") and row.get("ended_at"):
        return int((row["ended_at"] - row["started_at"]).total_seconds())
    return None


@router.get("/agendas")
async def list_agendas(current_user: CurrentUser = Depends(get_current_user)):
    """Built-in agenda templates (shown on the Agendas tab and the Start picker)."""
    return [
        {"key": a["key"], "name": a["name"], "type": a["type"],
         "total_minutes": agendas.total_minutes(a), "sections": a["sections"]}
        for a in agendas.AGENDAS.values()
    ]


@router.get("", response_model=list[schemas.Meeting])
async def list_meetings(
    tenant_id: str | None = Query(default=None),
    q: str | None = Query(default=None),          # search title/notes/summary
    team_id: str | None = Query(default=None),
    since: str | None = Query(default=None),        # ISO date lower bound
    current_user: CurrentUser = Depends(get_current_user),
):
    """The meeting archive — searchable by keyword (title/notes/summary), team, and date."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT m.id, m.title, m.scheduled_at, m.status, m.notes, m.tenant_id,
                   m.agenda_key, m.started_at, m.ended_at, m.rating,
                   u.name AS created_by_name
            FROM meetings m
            LEFT JOIN users u ON u.id = m.created_by
            WHERE ($1::uuid IS NULL OR m.tenant_id = $1::uuid)
              AND ($2::uuid IS NULL OR m.team_id = $2::uuid)
              AND ($4::timestamptz IS NULL OR COALESCE(m.ended_at, m.scheduled_at, m.created_at) >= $4::timestamptz)
              AND ($3::text IS NULL OR m.title ILIKE '%'||$3||'%' OR m.notes ILIKE '%'||$3||'%' OR m.summary::text ILIKE '%'||$3||'%')
            ORDER BY COALESCE(m.ended_at, m.started_at, m.scheduled_at, m.created_at) DESC
            """,
            target_tenant, team_id, q, since,
        )
    out = []
    for r in rows:
        d = dict(r)
        d["duration_seconds"] = _duration_seconds(d)
        out.append(d)
    return out


@router.get("/{meeting_id}")
async def get_meeting(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            SELECT m.id, m.title, m.status, m.notes, m.tenant_id, m.agenda_key,
                   m.sections, m.started_at, m.ended_at, m.rating, m.team_id, m.summary,
                   u.name AS facilitator_name, t.name AS team_name
            FROM meetings m
            LEFT JOIN users u ON u.id = m.created_by
            LEFT JOIN teams t ON t.id = m.team_id
            WHERE m.id = $1
            """,
            meeting_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
        d = dict(row)
        d["summary"] = json.loads(d["summary"]) if isinstance(d.get("summary"), str) else d.get("summary")
        att = await conn.fetch(
            "SELECT u.id, u.name FROM meeting_attendance a JOIN users u ON u.id=a.user_id WHERE a.meeting_id=$1 ORDER BY u.name",
            meeting_id)
        d["attendance"] = [{"id": str(r["id"]), "name": r["name"]} for r in att]
        # expected attendees = team members if a team was chosen, else everyone
        # who can be assigned work in this tenant (the directory)
        if d.get("team_id"):
            roster = await conn.fetch(
                "SELECT u.id, u.name FROM team_members tmb JOIN users u ON u.id = tmb.user_id WHERE tmb.team_id = $1",
                d["team_id"],
            )
        else:
            roster = await conn.fetch(
                """
                SELECT DISTINCT u.id, u.name FROM users u
                WHERE u.id = current_setting('app.current_user_id', true)::uuid
                   OR u.id IN (SELECT user_id FROM team_members)
                   OR u.id IN (SELECT user_id FROM tenant_memberships)
                ORDER BY u.name
                """
            )
    d["roster"] = [{"id": str(r["id"]), "name": r["name"]} for r in roster]
    d["sections"] = json.loads(d["sections"]) if d.get("sections") else []
    d["duration_seconds"] = _duration_seconds(d)
    return d


@router.post("")
async def create_meeting(body: NewMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO meetings (tenant_id, title, scheduled_at, notes, created_by)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, title, status, scheduled_at, tenant_id
            """,
            body.tenant_id, body.title, body.scheduled_at, body.notes, current_user.user_id,
        )
        # optional async calendar sync — never blocks / rolls back the meeting
        if body.calendar_provider in ("google", "microsoft"):
            await conn.execute(
                """INSERT INTO meeting_calendar_links (meeting_id, tenant_id, provider, sync_status)
                   VALUES ($1,$2,$3,'pending') ON CONFLICT (meeting_id, provider) DO NOTHING""",
                str(row["id"]), body.tenant_id, body.calendar_provider)
            await outbox.emit(conn, "calendar.create", aggregate_id=str(row["id"]), tenant_id=body.tenant_id,
                              payload={"meetingId": str(row["id"]), "tenantId": body.tenant_id,
                                       "provider": body.calendar_provider, "actorId": str(current_user.user_id),
                                       "title": body.title,
                                       "scheduledAt": body.scheduled_at.isoformat() if body.scheduled_at else None})
    return dict(row)


@router.get("/{meeting_id}/calendar")
async def calendar_status(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Calendar-sync status for a meeting (UI shows a synced / pending / failed chip)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """SELECT provider, sync_status, external_event_id, last_synced_at, last_error
               FROM meeting_calendar_links WHERE meeting_id=$1 ORDER BY provider""", meeting_id)
    return {"links": [dict(r) | {"last_synced_at": r["last_synced_at"].isoformat() if r["last_synced_at"] else None}
                      for r in rows]}


@router.post("/start")
async def start_meeting(body: StartMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Start a live meeting from an agenda: snapshot its sections, mark in_progress.
    The agenda_key may be a built-in EOS agenda or a saved custom template's id."""
    a = agendas.agenda(body.agenda_key)
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        if a is None:
            # custom template lookup (agenda_key is a template UUID)
            t = await conn.fetchrow("SELECT name, sections FROM agenda_templates WHERE id = $1", body.agenda_key)
            if t is None:
                raise HTTPException(status_code=404, detail="Unknown agenda")
            sections = json.loads(t["sections"]) if isinstance(t["sections"], str) else t["sections"]
            a = {"key": body.agenda_key, "name": t["name"], "sections": sections}
        row = await conn.fetchrow(
            """
            INSERT INTO meetings (tenant_id, title, status, agenda_key, sections, started_at, created_by, team_id)
            VALUES ($1, $2, 'in_progress', $3, $4::jsonb, now(), $5, $6)
            RETURNING id
            """,
            body.tenant_id, a["name"], a["key"], json.dumps(a["sections"]), current_user.user_id, body.team_id,
        )
        # normalized per-item agenda (source of truth for per-segment timers);
        # the JSONB snapshot above stays for the current runner until it's rewired
        await _materialize_agenda_items(conn, str(row["id"]), body.tenant_id, a["sections"])
        await outbox.emit(conn, "meeting.started", aggregate_id=str(row["id"]), tenant_id=body.tenant_id,
                          payload={"meetingId": str(row["id"]), "tenantId": body.tenant_id})
    return {"id": str(row["id"]), "agenda_key": a["key"]}


async def _materialize_agenda_items(conn, meeting_id: str, tenant_id: str, sections: list[dict]):
    """Copy an agenda snapshot into meeting_agenda_items rows. Idempotent: skips
    if this meeting already has items (so a re-start never duplicates)."""
    existing = await conn.fetchval("SELECT count(*) FROM meeting_agenda_items WHERE meeting_id = $1", meeting_id)
    if existing:
        return
    for i, s in enumerate(sections or []):
        await conn.execute(
            """INSERT INTO meeting_agenda_items
                   (meeting_id, tenant_id, segment_type, title, description, duration_seconds, display_order, config)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)""",
            meeting_id, tenant_id, s.get("kind", "text"), s.get("label", f"Segment {i+1}"),
            s.get("prompt"), int(s.get("minutes", 5)) * 60, i, json.dumps({"key": s.get("key")}))


# ---------------------------------------------------------------------------
# Lifecycle / state machine
# ---------------------------------------------------------------------------
async def _load_state(conn, meeting_id: str):
    m = await conn.fetchrow(
        "SELECT status, title, tenant_id, version, started_at, paused_at, accumulated_paused_seconds FROM meetings WHERE id = $1",
        meeting_id)
    if m is None:
        raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
    return m


def _check_version(m, expected: int | None):
    if expected is not None and m["version"] != expected:
        raise HTTPException(status_code=409, detail=f"Stale meeting version (have {m['version']}, sent {expected})")


@router.post("/{meeting_id}/start")
async def start_meeting_lifecycle(meeting_id: str, body: LifecycleRequest | None = None,
                                  idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
                                  current_user: CurrentUser = Depends(get_current_user)):
    """Transition a draft/scheduled meeting to IN_PROGRESS (idempotent)."""
    key_body = json.dumps((body.model_dump() if body else {}), default=str, sort_keys=True).encode()
    async with get_scoped_connection(current_user.user_id) as conn:
        prior = await idempotency.lookup(conn, current_user.user_id, "meeting.start", idempotency_key, key_body)
        if prior is not None:
            return prior
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await _load_state(conn, meeting_id)
        _assert_transition("start", m["status"])
        _check_version(m, body.expected_version if body else None)
        row = await conn.fetchrow(
            """UPDATE meetings SET status='in_progress',
                   started_at = COALESCE(started_at, now()), version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version, started_at""", meeting_id)
        await outbox.emit(conn, "meeting.started", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id)})
        result = {"id": meeting_id, "status": "in_progress", "version": row["version"],
                  "started_at": row["started_at"].isoformat() if row["started_at"] else None}
        await idempotency.save(conn, current_user.user_id, "meeting.start", idempotency_key, key_body,
                               tenant_id=str(tenant_id), response=result)
    return result


@router.post("/{meeting_id}/pause")
async def pause_meeting(meeting_id: str, body: LifecycleRequest | None = None,
                        current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await _load_state(conn, meeting_id)
        _assert_transition("pause", m["status"])
        _check_version(m, body.expected_version if body else None)
        row = await conn.fetchrow(
            "UPDATE meetings SET status='paused', paused_at=now(), version=version+1, updated_at=now() WHERE id=$1 RETURNING version",
            meeting_id)
        await outbox.emit(conn, "meeting.paused", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id)})
    return {"id": meeting_id, "status": "paused", "version": row["version"]}


@router.post("/{meeting_id}/resume")
async def resume_meeting(meeting_id: str, body: LifecycleRequest | None = None,
                         current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await _load_state(conn, meeting_id)
        _assert_transition("resume", m["status"])
        _check_version(m, body.expected_version if body else None)
        # fold the paused interval into accumulated paused time, then clear the marker
        row = await conn.fetchrow(
            """UPDATE meetings SET status='in_progress',
                   accumulated_paused_seconds = accumulated_paused_seconds
                       + CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END,
                   paused_at = NULL, version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version, accumulated_paused_seconds""", meeting_id)
        await outbox.emit(conn, "meeting.resumed", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id)})
    return {"id": meeting_id, "status": "in_progress", "version": row["version"],
            "accumulated_paused_seconds": row["accumulated_paused_seconds"]}


@router.post("/{meeting_id}/cancel")
async def cancel_meeting(meeting_id: str, body: LifecycleRequest | None = None,
                         current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await _load_state(conn, meeting_id)
        _assert_transition("cancel", m["status"])
        _check_version(m, body.expected_version if body else None)
        row = await conn.fetchrow(
            "UPDATE meetings SET status='cancelled', version=version+1, updated_at=now() WHERE id=$1 RETURNING version",
            meeting_id)
        await outbox.emit(conn, "meeting.cancelled", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id), "reason": (body.reason if body else None)})
        await audit.log(conn, current_user.user_id, "meeting.cancelled", entity_type="meeting",
                        entity_id=meeting_id, tenant_id=str(tenant_id), detail=m["title"])
    return {"id": meeting_id, "status": "cancelled", "version": row["version"]}


@router.post("/{meeting_id}/current-section")
async def set_current_section(meeting_id: str, body: SectionRequest,
                              current_user: CurrentUser = Depends(get_current_user)):
    """Server-authoritative current agenda segment, so a reconnecting client
    lands on the segment the facilitator actually advanced to."""
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await _load_state(conn, meeting_id)
        _check_version(m, body.expected_version)
        row = await conn.fetchrow(
            "UPDATE meetings SET current_section_index=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING version",
            meeting_id, body.index)
        await outbox.emit(conn, "segment.changed", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id), "index": body.index, "version": row["version"]})
    return {"id": meeting_id, "current_section_index": body.index, "version": row["version"]}


# ---------------------------------------------------------------------------
# Completion (state-machine-guarded, idempotent, writes the outbox event)
# ---------------------------------------------------------------------------
async def _complete_core(conn, user_id: str, meeting_id: str, *, rating, notes, attendee_ids):
    tenant_id = await require_row_permission(conn, user_id, "meetings", meeting_id, "edit")
    m = await _load_state(conn, meeting_id)
    _assert_transition("complete", m["status"])

    if attendee_ids:
        await conn.execute("DELETE FROM meeting_attendance WHERE meeting_id = $1", meeting_id)
        for uid in attendee_ids:
            if uid:
                await conn.execute(
                    "INSERT INTO meeting_attendance (meeting_id, user_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                    meeting_id, uid, tenant_id)

    # fold any open pause into accumulated time, then close
    await conn.execute(
        """UPDATE meetings SET
               status='completed', ended_at=now(),
               accumulated_paused_seconds = accumulated_paused_seconds
                   + CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END,
               paused_at = NULL,
               rating = COALESCE($2, rating), notes = COALESCE($3, notes),
               version = version + 1, updated_at = now()
           WHERE id = $1""",
        meeting_id, rating, notes)

    summary = await meeting_summary.build_summary(conn, meeting_id)
    await conn.execute("UPDATE meetings SET summary = $2::jsonb WHERE id = $1", meeting_id, json.dumps(summary))

    payload = {
        "meetingId": meeting_id, "tenantId": str(tenant_id), "title": m["title"],
        "actorId": str(user_id),   # worker scopes its RLS reads to the completer
        "durationSeconds": summary["duration_seconds"], "presentCount": summary["attendance"],
        "issuesCreated": len(summary["issues_raised"]), "issuesResolved": summary["issues_solved"],
        "todosCreated": len(summary["todos_created"]), "averageRating": summary["rating"],
    }
    await outbox.emit(conn, "meeting.completed", aggregate_id=meeting_id, tenant_id=str(tenant_id), payload=payload)
    await audit.log(conn, user_id, "meeting.completed", entity_type="meeting", entity_id=meeting_id,
                    tenant_id=str(tenant_id), detail=f"{m['title']} · rated {rating if rating is not None else '—'}")
    return {"id": meeting_id, "duration_seconds": summary["duration_seconds"], "summary": summary}


async def _complete_endpoint(meeting_id, body, idempotency_key, current_user):
    key_body = json.dumps(body.model_dump(), default=str, sort_keys=True).encode()
    async with get_scoped_connection(current_user.user_id) as conn:
        prior = await idempotency.lookup(conn, current_user.user_id, "meeting.complete", idempotency_key, key_body)
        if prior is not None:
            return prior
        result = await _complete_core(conn, current_user.user_id, meeting_id,
                                      rating=body.rating, notes=body.notes, attendee_ids=body.attendee_ids)
        await idempotency.save(conn, current_user.user_id, "meeting.complete", idempotency_key, key_body,
                               status=200, response=result)
    return result


@router.post("/{meeting_id}/complete")
async def complete_meeting(meeting_id: str, body: FinishMeetingRequest,
                           idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
                           current_user: CurrentUser = Depends(get_current_user)):
    """Complete a live meeting: persist attendance, generate the summary, emit the
    meeting.completed outbox event (worker republishes + notifies). Idempotent."""
    return await _complete_endpoint(meeting_id, body, idempotency_key, current_user)


@router.post("/{meeting_id}/finish")
async def finish_meeting(meeting_id: str, body: FinishMeetingRequest,
                         idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
                         current_user: CurrentUser = Depends(get_current_user)):
    """Legacy alias the live runner calls — delegates to /complete."""
    return await _complete_endpoint(meeting_id, body, idempotency_key, current_user)


@router.get("/{meeting_id}/live-state")
async def live_state(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Everything a (re)connecting client needs to restore the runner without
    replaying missed events: status, versions, server clock, timer, agenda,
    attendance, and recently-created issues/todos."""
    async with get_scoped_connection(current_user.user_id) as conn:
        m = await conn.fetchrow(
            """SELECT id, title, status, tenant_id, version, agenda_version, current_section_index,
                      sections, started_at, paused_at, accumulated_paused_seconds, rating
               FROM meetings WHERE id = $1""", meeting_id)
        if m is None:
            raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
        server_now = await conn.fetchval("SELECT now()")
        att = await conn.fetch(
            "SELECT u.id, u.name FROM meeting_attendance a JOIN users u ON u.id=a.user_id WHERE a.meeting_id=$1 ORDER BY u.name",
            meeting_id)
        recent_issues = recent_todos = []
        if m["started_at"]:
            recent_issues = [dict(r) for r in await conn.fetch(
                "SELECT id, title, status FROM issues WHERE tenant_id=$1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20",
                m["tenant_id"], m["started_at"])]
            recent_todos = [dict(r) for r in await conn.fetch(
                "SELECT id, title, status FROM todos WHERE tenant_id=$1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20",
                m["tenant_id"], m["started_at"])]
        items = await conn.fetch(
            """SELECT id, segment_type, title, description, duration_seconds, display_order, status,
                      started_at, paused_at, completed_at, accumulated_paused_seconds, notes, version
               FROM meeting_agenda_items WHERE meeting_id=$1 ORDER BY display_order""", meeting_id)
        can_edit = await _can_edit(conn, current_user.user_id, m["tenant_id"])
        role = await effective_role(conn, current_user.user_id, str(m["tenant_id"]))
    sections = json.loads(m["sections"]) if isinstance(m["sections"], str) else (m["sections"] or [])
    return {
        "id": str(m["id"]), "title": m["title"], "status": m["status"],
        "version": m["version"], "agenda_version": m["agenda_version"],
        "current_section_index": m["current_section_index"],
        "timer": {
            "started_at": m["started_at"].isoformat() if m["started_at"] else None,
            "paused_at": m["paused_at"].isoformat() if m["paused_at"] else None,
            "accumulated_paused_seconds": m["accumulated_paused_seconds"],
            "server_now": server_now.isoformat(),
        },
        "sections": sections,
        "agenda_items": [_item_dto(r) for r in items],
        "attendance": [{"id": str(r["id"]), "name": r["name"]} for r in att],
        "recent_issues": [{"id": str(r["id"]), "title": r["title"], "status": r["status"]} for r in recent_issues],
        "recent_todos": [{"id": str(r["id"]), "title": r["title"], "status": r["status"]} for r in recent_todos],
        "permissions": {"role": role, "can_edit": can_edit},
    }


@router.post("/{meeting_id}/ratings")
async def submit_rating(meeting_id: str, body: RatingRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Submit (or update) THIS user's 1–10 rating for a meeting. One row per user
    (upsert). Recomputes the cached meetings.rating average so the trend/history
    keep working. Any attendee may rate — completion is never blocked on ratings."""
    if not (1 <= body.rating <= 10):
        raise HTTPException(status_code=422, detail="rating must be between 1 and 10")
    async with get_scoped_connection(current_user.user_id) as conn:
        # RLS already guarantees the caller can see the meeting; 404 if not.
        tenant_id = await conn.fetchval("SELECT tenant_id FROM meetings WHERE id = $1", meeting_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
        await conn.execute(
            """INSERT INTO meeting_ratings (meeting_id, user_id, tenant_id, rating, feedback)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (meeting_id, user_id)
               DO UPDATE SET rating=EXCLUDED.rating, feedback=EXCLUDED.feedback, updated_at=now()""",
            meeting_id, current_user.user_id, tenant_id, body.rating, body.feedback)
        agg = await conn.fetchrow(
            "SELECT round(avg(rating),1) AS avg, count(*) AS n FROM meeting_ratings WHERE meeting_id=$1", meeting_id)
        await conn.execute("UPDATE meetings SET rating=$2, updated_at=now() WHERE id=$1", meeting_id, agg["avg"])
    return {"meeting_id": meeting_id, "average": float(agg["avg"]) if agg["avg"] is not None else None,
            "count": agg["n"], "my_rating": body.rating}


@router.get("/{meeting_id}/ratings")
async def list_ratings(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """All ratings for a meeting + the average (for the rating summary panel)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """SELECT r.rating, r.feedback, r.submitted_at, u.name, r.user_id
               FROM meeting_ratings r JOIN users u ON u.id=r.user_id
               WHERE r.meeting_id=$1 ORDER BY r.submitted_at""", meeting_id)
    ratings = [{"user_id": str(r["user_id"]), "name": r["name"], "rating": float(r["rating"]),
                "feedback": r["feedback"], "submitted_at": r["submitted_at"].isoformat()} for r in rows]
    avg = round(sum(x["rating"] for x in ratings) / len(ratings), 1) if ratings else None
    return {"ratings": ratings, "average": avg, "count": len(ratings)}


@router.get("/ratings/trend")
async def ratings_trend(
    tenant_id: str | None = Query(default=None),
    team_id: str | None = Query(default=None),
    limit: int = Query(default=20),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Meeting-rating history (oldest→newest) for the sparkline / trend view [AC5]."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, rating, COALESCE(ended_at, scheduled_at, created_at) AS at
            FROM meetings
            WHERE rating IS NOT NULL
              AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
              AND ($2::uuid IS NULL OR team_id = $2::uuid)
            ORDER BY COALESCE(ended_at, scheduled_at, created_at) DESC
            LIMIT $3
            """,
            target_tenant, team_id, limit,
        )
    pts = [{"id": str(r["id"]), "title": r["title"], "rating": float(r["rating"]),
            "at": r["at"].isoformat() if r["at"] else None} for r in reversed(rows)]
    avg = round(sum(p["rating"] for p in pts) / len(pts), 1) if pts else None
    return {"points": pts, "average": avg, "count": len(pts)}


@router.get("/templates/list")
async def list_templates(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Custom agenda templates saved for this tenant."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            "SELECT id, tenant_id, name, sections, created_by FROM agenda_templates WHERE ($1::uuid IS NULL OR tenant_id=$1::uuid) ORDER BY name",
            target_tenant)
    out = []
    for r in rows:
        d = dict(r)
        d["sections"] = json.loads(d["sections"]) if isinstance(d.get("sections"), str) else d["sections"]
        d["id"] = str(d["id"]); d["tenant_id"] = str(d["tenant_id"])
        out.append(d)
    return out


@router.post("/templates")
async def create_template(body: TemplateRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            "INSERT INTO agenda_templates (tenant_id, name, sections, created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING id",
            body.tenant_id, body.name, json.dumps(body.sections), current_user.user_id)
    return {"id": str(row["id"])}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        result = await conn.execute("DELETE FROM agenda_templates WHERE id = $1", template_id)
    return {"deleted": result}


# ---------------------------------------------------------------------------
# Per-item agenda: state machine, server-authoritative per-segment timer, reorder
# ---------------------------------------------------------------------------
_ITEM_ALLOWED_FROM = {
    "start":    {"PENDING", "SKIPPED"},
    "pause":    {"IN_PROGRESS"},
    "resume":   {"PAUSED"},
    "complete": {"IN_PROGRESS", "PAUSED"},
    "skip":     {"PENDING", "IN_PROGRESS", "PAUSED"},
}
_ITEM_TARGET = {"start": "IN_PROGRESS", "pause": "PAUSED", "resume": "IN_PROGRESS",
                "complete": "COMPLETED", "skip": "SKIPPED"}


def _item_dto(r) -> dict:
    return {
        "id": str(r["id"]), "segment_type": r["segment_type"], "title": r["title"],
        "description": r["description"], "duration_seconds": r["duration_seconds"],
        "display_order": r["display_order"], "status": r["status"],
        "started_at": r["started_at"].isoformat() if r["started_at"] else None,
        "paused_at": r["paused_at"].isoformat() if r["paused_at"] else None,
        "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
        "accumulated_paused_seconds": r["accumulated_paused_seconds"],
        "notes": r["notes"], "version": r["version"],
    }


async def _item_action(meeting_id: str, item_id: str, action: str, body, current_user):
    """Shared handler for start/pause/resume/complete/skip on one agenda item."""
    async with get_scoped_connection(current_user.user_id) as conn:
        item_tenant = await require_row_permission(conn, current_user.user_id, "meeting_agenda_items", item_id, "edit")
        it = await conn.fetchrow(
            "SELECT status, version, paused_at FROM meeting_agenda_items WHERE id=$1 AND meeting_id=$2",
            item_id, meeting_id)
        if it is None:
            raise HTTPException(status_code=404, detail="Agenda item not found")
        if it["status"] not in _ITEM_ALLOWED_FROM[action]:
            raise HTTPException(status_code=409, detail=f"Cannot {action} a segment in state '{it['status']}'")
        if body and body.expected_version is not None and it["version"] != body.expected_version:
            raise HTTPException(status_code=409, detail=f"Stale segment version (have {it['version']}, sent {body.expected_version})")

        target = _ITEM_TARGET[action]
        sets = ["status = $3", "version = version + 1", "updated_at = now()"]
        if action == "start":
            sets.append("started_at = COALESCE(started_at, now())")
        elif action == "pause":
            sets.append("paused_at = now()")
        elif action in ("resume", "complete"):
            sets.append("accumulated_paused_seconds = accumulated_paused_seconds + "
                        "CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END")
            sets.append("paused_at = NULL")
            if action == "complete":
                sets.append("completed_at = now()")
        row = await conn.fetchrow(
            f"UPDATE meeting_agenda_items SET {', '.join(sets)} WHERE id=$1 AND meeting_id=$2 "
            f"RETURNING id, segment_type, title, description, duration_seconds, display_order, status, "
            f"started_at, paused_at, completed_at, accumulated_paused_seconds, notes, version",
            item_id, meeting_id, target)
        await outbox.emit(conn, "segment.updated", aggregate_id=meeting_id, tenant_id=str(item_tenant),
                          payload={"meetingId": meeting_id, "tenantId": str(item_tenant), "itemId": item_id, "action": action, "status": target})
    return _item_dto(row)


@router.post("/{meeting_id}/agenda-items/reorder")
async def reorder_agenda_items(meeting_id: str, body: dict, current_user: CurrentUser = Depends(get_current_user)):
    """Reorder the agenda as ONE versioned aggregate. Validates every id belongs
    to the meeting and the expected agenda_version, applies all positions in a
    single transaction (deferred unique constraint), and bumps agenda_version.
    Never partially applied."""
    ordered = body.get("orderedAgendaItemIds") or []
    expected = body.get("version")
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        m = await conn.fetchrow("SELECT agenda_version FROM meetings WHERE id=$1", meeting_id)
        if m is None:
            raise HTTPException(status_code=404, detail="Meeting not found")
        if expected is not None and m["agenda_version"] != expected:
            raise HTTPException(status_code=409, detail=f"Stale agenda version (have {m['agenda_version']}, sent {expected})")
        ids = [r["id"] for r in await conn.fetch("SELECT id FROM meeting_agenda_items WHERE meeting_id=$1", meeting_id)]
        id_set = {str(x) for x in ids}
        if set(ordered) != id_set or len(ordered) != len(id_set):
            raise HTTPException(status_code=422, detail="orderedAgendaItemIds must be exactly the meeting's agenda items")
        # push to high temp orders first to dodge the unique constraint mid-shuffle, then final
        for i, iid in enumerate(ordered):
            await conn.execute("UPDATE meeting_agenda_items SET display_order=$2 WHERE id=$1 AND meeting_id=$3",
                               iid, 1000 + i, meeting_id)
        for i, iid in enumerate(ordered):
            await conn.execute("UPDATE meeting_agenda_items SET display_order=$2, version=version+1, updated_at=now() WHERE id=$1 AND meeting_id=$3",
                               iid, i, meeting_id)
        row = await conn.fetchrow(
            "UPDATE meetings SET agenda_version=agenda_version+1, version=version+1, updated_at=now() WHERE id=$1 RETURNING agenda_version",
            meeting_id)
        await outbox.emit(conn, "agenda.reordered", aggregate_id=meeting_id, tenant_id=str(tenant_id),
                          payload={"meetingId": meeting_id, "tenantId": str(tenant_id), "order": ordered})
    return {"meeting_id": meeting_id, "agenda_version": row["agenda_version"], "order": ordered}


@router.post("/{meeting_id}/agenda-items/{item_id}/start")
async def item_start(meeting_id: str, item_id: str, body: LifecycleRequest | None = None, current_user: CurrentUser = Depends(get_current_user)):
    return await _item_action(meeting_id, item_id, "start", body, current_user)

@router.post("/{meeting_id}/agenda-items/{item_id}/pause")
async def item_pause(meeting_id: str, item_id: str, body: LifecycleRequest | None = None, current_user: CurrentUser = Depends(get_current_user)):
    return await _item_action(meeting_id, item_id, "pause", body, current_user)

@router.post("/{meeting_id}/agenda-items/{item_id}/resume")
async def item_resume(meeting_id: str, item_id: str, body: LifecycleRequest | None = None, current_user: CurrentUser = Depends(get_current_user)):
    return await _item_action(meeting_id, item_id, "resume", body, current_user)

@router.post("/{meeting_id}/agenda-items/{item_id}/complete")
async def item_complete(meeting_id: str, item_id: str, body: LifecycleRequest | None = None, current_user: CurrentUser = Depends(get_current_user)):
    return await _item_action(meeting_id, item_id, "complete", body, current_user)

@router.post("/{meeting_id}/agenda-items/{item_id}/skip")
async def item_skip(meeting_id: str, item_id: str, body: LifecycleRequest | None = None, current_user: CurrentUser = Depends(get_current_user)):
    return await _item_action(meeting_id, item_id, "skip", body, current_user)


@router.patch("/{meeting_id}")
async def update_meeting(meeting_id: str, body: UpdateMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit meeting metadata (title/schedule/notes) with optimistic locking.
    Status changes go through the lifecycle endpoints, not here."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        # atomic conditional update: only applies when the version still matches
        row = await conn.fetchrow(
            """
            UPDATE meetings SET
                title = COALESCE($2, title),
                scheduled_at = COALESCE($3, scheduled_at),
                notes = COALESCE($4, notes),
                version = version + 1,
                updated_at = now()
            WHERE id = $1 AND ($5::int IS NULL OR version = $5::int)
            RETURNING id, title, status, scheduled_at, tenant_id, version
            """,
            meeting_id, body.title, body.scheduled_at, body.notes, body.expected_version,
        )
        if row is None:
            # distinguish "gone" from "stale version" for a useful client message
            exists = await conn.fetchval("SELECT version FROM meetings WHERE id = $1", meeting_id)
            if exists is None:
                raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
            raise HTTPException(status_code=409, detail=f"Stale meeting version (current {exists}, sent {body.expected_version})")
    return dict(row)


@router.delete("/{meeting_id}")
async def delete_meeting(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "delete")
        result = await conn.execute("DELETE FROM meetings WHERE id = $1", meeting_id)
    return {"deleted": result}
