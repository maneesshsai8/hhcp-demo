import json
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import datetime

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import schemas, agendas

router = APIRouter(prefix="/meetings", tags=["meetings"])


class NewMeetingRequest(BaseModel):
    tenant_id: str
    title: str
    scheduled_at: datetime | None = None
    notes: str | None = None


class UpdateMeetingRequest(BaseModel):
    title: str | None = None
    scheduled_at: datetime | None = None
    status: str | None = None       # 'scheduled' | 'in_progress' | 'completed'
    notes: str | None = None


class StartMeetingRequest(BaseModel):
    tenant_id: str
    agenda_key: str
    team_id: str | None = None


class FinishMeetingRequest(BaseModel):
    rating: float | None = None
    notes: str | None = None


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
async def list_meetings(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
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
            ORDER BY COALESCE(m.ended_at, m.started_at, m.scheduled_at, m.created_at) DESC
            """,
            target_tenant,
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
                   m.sections, m.started_at, m.ended_at, m.rating, m.team_id,
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
    return dict(row)


@router.post("/start")
async def start_meeting(body: StartMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Start a live meeting from an agenda: snapshot its sections, mark in_progress."""
    a = agendas.agenda(body.agenda_key)
    if a is None:
        raise HTTPException(status_code=404, detail="Unknown agenda")
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO meetings (tenant_id, title, status, agenda_key, sections, started_at, created_by, team_id)
            VALUES ($1, $2, 'in_progress', $3, $4::jsonb, now(), $5, $6)
            RETURNING id
            """,
            body.tenant_id, a["name"], a["key"], json.dumps(a["sections"]), current_user.user_id, body.team_id,
        )
    return {"id": str(row["id"]), "agenda_key": a["key"]}


@router.post("/{meeting_id}/finish")
async def finish_meeting(meeting_id: str, body: FinishMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        row = await conn.fetchrow(
            """
            UPDATE meetings SET
                status = 'completed',
                ended_at = now(),
                rating = COALESCE($2, rating),
                notes = COALESCE($3, notes)
            WHERE id = $1
            RETURNING id, started_at, ended_at
            """,
            meeting_id, body.rating, body.notes,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
    return {"id": str(row["id"]), "duration_seconds": _duration_seconds(dict(row))}


@router.patch("/{meeting_id}")
async def update_meeting(meeting_id: str, body: UpdateMeetingRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "edit")
        row = await conn.fetchrow(
            """
            UPDATE meetings SET
                title = COALESCE($2, title),
                scheduled_at = COALESCE($3, scheduled_at),
                status = COALESCE($4, status),
                notes = COALESCE($5, notes)
            WHERE id = $1
            RETURNING id, title, status, scheduled_at, tenant_id
            """,
            meeting_id, body.title, body.scheduled_at, body.status, body.notes,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Meeting not found or not accessible")
    return dict(row)


@router.delete("/{meeting_id}")
async def delete_meeting(meeting_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "meetings", meeting_id, "delete")
        result = await conn.execute("DELETE FROM meetings WHERE id = $1", meeting_id)
    return {"deleted": result}
