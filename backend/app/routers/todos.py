from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import schemas

router = APIRouter(prefix="/todos", tags=["todos"])


class NewTodoRequest(BaseModel):
    tenant_id: str
    title: str
    description: str | None = None
    due_date: date | None = None
    owner_id: str | None = None
    team_id: str | None = None
    is_private: bool = False


class UpdateTodoRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    due_date: date | None = None
    owner_id: str | None = None
    team_id: str | None = None
    status: str | None = None       # 'open' | 'done'


@router.get("", response_model=list[schemas.Todo])
async def list_todos(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT t.id, t.title, t.description, t.due_date, t.status, t.is_private, t.tenant_id,
                   u.name AS owner_name, tm.name AS team_name
            FROM todos t
            LEFT JOIN users u ON u.id = t.owner_id
            LEFT JOIN teams tm ON tm.id = t.team_id
            WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
            ORDER BY t.status, t.due_date NULLS LAST, t.created_at DESC
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_todo(body: NewTodoRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO todos (tenant_id, title, description, due_date, owner_id, team_id, is_private)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, title, status, tenant_id
            """,
            body.tenant_id, body.title, body.description, body.due_date,
            body.owner_id or current_user.user_id, body.team_id, body.is_private,
        )
    return dict(row)


@router.patch("/{todo_id}")
async def update_todo(todo_id: str, body: UpdateTodoRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "todos", todo_id, "edit")
        row = await conn.fetchrow(
            """
            UPDATE todos SET
                title = COALESCE($2, title),
                description = COALESCE($3, description),
                due_date = COALESCE($4, due_date),
                owner_id = COALESCE($5, owner_id),
                team_id = COALESCE($6, team_id),
                status = COALESCE($7, status)
            WHERE id = $1
            RETURNING id, title, status, tenant_id
            """,
            todo_id, body.title, body.description, body.due_date, body.owner_id, body.team_id, body.status,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="To-Do not found or not accessible")
    return dict(row)


@router.delete("/{todo_id}")
async def delete_todo(todo_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "todos", todo_id, "delete")
        result = await conn.execute("DELETE FROM todos WHERE id = $1", todo_id)
    return {"deleted": result}
