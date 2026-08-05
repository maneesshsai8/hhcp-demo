from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import audit

router = APIRouter(prefix="/rocks", tags=["rocks"])


class NewRockRequest(BaseModel):
    tenant_id: str
    title: str
    due_date: date | None = None
    team_id: str | None = None
    owner_id: str | None = None                # kept for back-compat (single owner)
    assignee_ids: list[str] | None = None      # multi-assignee; first becomes primary owner
    description: str | None = None
    workstream_id: str | None = None           # ladders this Rock up to a VCB workstream


class UpdateRockRequest(BaseModel):
    title: str | None = None
    status: str | None = None       # 'on_track' | 'off_track' | 'complete'
    due_date: date | None = None
    team_id: str | None = None
    owner_id: str | None = None
    assignee_ids: list[str] | None = None
    description: str | None = None
    workstream_id: str | None = None


async def _sync_assignees(conn, rock_id, tenant_id, assignee_ids):
    """Replace a rock's assignee set. Returns the primary (first) assignee id."""
    await conn.execute("DELETE FROM rock_assignees WHERE rock_id = $1", rock_id)
    seen = []
    for uid in assignee_ids:
        if uid and uid not in seen:
            await conn.execute(
                "INSERT INTO rock_assignees (rock_id, user_id, tenant_id) VALUES ($1, $2, $3) "
                "ON CONFLICT (rock_id, user_id) DO NOTHING",
                rock_id, uid, tenant_id,
            )
            seen.append(uid)
    return seen[0] if seen else None


@router.get("", response_model=None)
async def list_rocks(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT r.id, r.title, r.status, r.due_date, r.tenant_id, r.description,
                   r.owner_id, u.name AS owner_name, t.name AS team_name,
                   r.workstream_id, w.name AS workstream_name, w.vcb_id, v.title AS vcb_title,
                   COALESCE(
                     (SELECT json_agg(json_build_object('id', ra.user_id, 'name', au.name) ORDER BY au.name)
                      FROM rock_assignees ra JOIN users au ON au.id = ra.user_id
                      WHERE ra.rock_id = r.id),
                     '[]'::json) AS assignees
            FROM rocks r
            LEFT JOIN users u ON u.id = r.owner_id
            LEFT JOIN teams t ON t.id = r.team_id
            LEFT JOIN workstreams w ON w.id = r.workstream_id
            LEFT JOIN vcbs v ON v.id = w.vcb_id
            WHERE ($1::uuid IS NULL OR r.tenant_id = $1::uuid)
            ORDER BY r.status, r.due_date
            """,
            target_tenant,
        )
    out = []
    for r in rows:
        d = dict(r)
        import json
        d["assignees"] = json.loads(d["assignees"]) if isinstance(d["assignees"], str) else d["assignees"]
        out.append(d)
    return out


@router.post("")
async def create_rock(body: NewRockRequest, current_user: CurrentUser = Depends(get_current_user)):
    assignees = body.assignee_ids if body.assignee_ids is not None else (
        [body.owner_id] if body.owner_id else [current_user.user_id])
    assignees = [a for a in assignees if a] or [current_user.user_id]
    primary = assignees[0]
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO rocks (tenant_id, title, owner_id, due_date, team_id, description, workstream_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, title, status, due_date, tenant_id
            """,
            body.tenant_id, body.title, primary,
            body.due_date, body.team_id, body.description, body.workstream_id,
        )
        await _sync_assignees(conn, row["id"], body.tenant_id, assignees)
    return dict(row)


@router.patch("/{rock_id}")
async def update_rock(rock_id: str, body: UpdateRockRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "rocks", rock_id, "edit")
        before = await conn.fetchval("SELECT status FROM rocks WHERE id = $1", rock_id)

        # If a new assignee set is given, the primary owner follows the first one.
        primary = None
        if body.assignee_ids is not None:
            primary = await _sync_assignees(conn, rock_id, str(tenant_id), body.assignee_ids)
        owner_override = primary or body.owner_id

        row = await conn.fetchrow(
            """
            UPDATE rocks SET
                title = COALESCE($2, title),
                status = COALESCE($3, status),
                due_date = COALESCE($4, due_date),
                team_id = COALESCE($5, team_id),
                owner_id = COALESCE($6, owner_id),
                description = COALESCE($7, description),
                workstream_id = COALESCE($8, workstream_id)
            WHERE id = $1
            RETURNING id, title, status, due_date, tenant_id
            """,
            rock_id, body.title, body.status, body.due_date, body.team_id, owner_override,
            body.description, body.workstream_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Rock not found or not accessible")
        # Emit a Rock status-change event — rolls up to workstream/VCB, and feeds the
        # Phase 2 OS Compliance Dashboard from day one.
        if body.status and body.status != before:
            await audit.log(conn, current_user.user_id, "rock.status", entity_type="rock",
                            entity_id=rock_id, tenant_id=str(tenant_id),
                            detail=f"{row['title']}: {before} → {body.status}")
    return dict(row)


@router.delete("/{rock_id}")
async def delete_rock(rock_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "rocks", rock_id, "delete")
        result = await conn.execute("DELETE FROM rocks WHERE id = $1", rock_id)
    return {"deleted": result}
