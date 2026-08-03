from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import datetime

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import schemas

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


@router.get("", response_model=list[schemas.Meeting])
async def list_meetings(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT m.id, m.title, m.scheduled_at, m.status, m.notes, m.tenant_id,
                   u.name AS created_by_name
            FROM meetings m
            LEFT JOIN users u ON u.id = m.created_by
            WHERE ($1::uuid IS NULL OR m.tenant_id = $1::uuid)
            ORDER BY m.scheduled_at DESC NULLS LAST, m.created_at DESC
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


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
