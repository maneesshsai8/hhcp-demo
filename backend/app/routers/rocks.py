from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import schemas

router = APIRouter(prefix="/rocks", tags=["rocks"])


class NewRockRequest(BaseModel):
    tenant_id: str
    title: str
    due_date: date | None = None
    team_id: str | None = None
    owner_id: str | None = None
    description: str | None = None


class UpdateRockRequest(BaseModel):
    title: str | None = None
    status: str | None = None       # 'on_track' | 'off_track' | 'complete'
    due_date: date | None = None
    team_id: str | None = None
    owner_id: str | None = None
    description: str | None = None


@router.get("", response_model=list[schemas.Rock])
async def list_rocks(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT r.id, r.title, r.status, r.due_date, r.tenant_id, r.description,
                   u.name AS owner_name, t.name AS team_name
            FROM rocks r
            LEFT JOIN users u ON u.id = r.owner_id
            LEFT JOIN teams t ON t.id = r.team_id
            WHERE ($1::uuid IS NULL OR r.tenant_id = $1::uuid)
            ORDER BY r.status, r.due_date
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_rock(body: NewRockRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO rocks (tenant_id, title, owner_id, due_date, team_id, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, title, status, due_date, tenant_id
            """,
            body.tenant_id, body.title, body.owner_id or current_user.user_id,
            body.due_date, body.team_id, body.description,
        )
    return dict(row)


@router.patch("/{rock_id}")
async def update_rock(rock_id: str, body: UpdateRockRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "rocks", rock_id, "edit")
        row = await conn.fetchrow(
            """
            UPDATE rocks SET
                title = COALESCE($2, title),
                status = COALESCE($3, status),
                due_date = COALESCE($4, due_date),
                team_id = COALESCE($5, team_id),
                owner_id = COALESCE($6, owner_id),
                description = COALESCE($7, description)
            WHERE id = $1
            RETURNING id, title, status, due_date, tenant_id
            """,
            rock_id, body.title, body.status, body.due_date, body.team_id, body.owner_id, body.description,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Rock not found or not accessible")
    return dict(row)


@router.delete("/{rock_id}")
async def delete_rock(rock_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "rocks", rock_id, "delete")
        result = await conn.execute("DELETE FROM rocks WHERE id = $1", rock_id)
    return {"deleted": result}
