from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission

router = APIRouter(prefix="/todos", tags=["todos"])


class NewTodoRequest(BaseModel):
    tenant_id: str
    title: str
    description: str | None = None
    due_date: date | None = None
    owner_id: str | None = None
    team_id: str | None = None
    priority: str = "medium"              # 'low' | 'medium' | 'high'
    is_private: bool = False
    source: str = "manual"                # 'manual' | 'meeting' | 'issue' | 'scorecard'
    issue_id: str | None = None
    vcb_id: str | None = None


class UpdateTodoRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    due_date: date | None = None
    owner_id: str | None = None
    team_id: str | None = None
    priority: str | None = None
    status: str | None = None             # 'open' | 'done'
    completion_note: str | None = None
    issue_id: str | None = None
    vcb_id: str | None = None


def _shape(r: dict) -> dict:
    d = dict(r)
    due = d.get("due_date")
    d["is_overdue"] = bool(due and d["status"] == "open" and due < date.today())
    return d


@router.get("")
async def list_todos(
    tenant_id: str | None = Query(default=None),
    mine: bool = Query(default=False),                 # personal 'My To-Dos' view
    status: str | None = Query(default=None),          # 'open' | 'done'
    window: str | None = Query(default=None),          # '7' | '90' — due within N days (or overdue)
    owner_id: str | None = Query(default=None),
    team_id: str | None = Query(default=None),
    overdue_only: bool = Query(default=False),
    current_user: CurrentUser = Depends(get_current_user),
):
    """The unified task list. Filters compose: personal view, status, owner, team,
    7/90-day windows, and overdue-only — all still under RLS."""
    target_tenant = tenant_id or current_user.active_tenant_id
    me = current_user.user_id if mine else None
    days = int(window) if window in ("7", "90") else None
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT t.id, t.title, t.description, t.due_date, t.status, t.is_private, t.priority,
                   t.tenant_id, t.source, t.carried_count, t.completion_note, t.completed_at,
                   t.owner_id, t.team_id, t.vcb_id, t.issue_id,
                   u.name AS owner_name, tm.name AS team_name,
                   v.title AS vcb_title, i.title AS issue_title
            FROM todos t
            LEFT JOIN users u ON u.id = t.owner_id
            LEFT JOIN teams tm ON tm.id = t.team_id
            LEFT JOIN vcbs v ON v.id = t.vcb_id
            LEFT JOIN issues i ON i.id = t.issue_id
            WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
              AND ($2::uuid IS NULL OR t.owner_id = $2::uuid)
              AND ($3::uuid IS NULL OR t.owner_id = $3::uuid)
              AND ($4::text IS NULL OR t.status = $4::text)
              AND ($5::uuid IS NULL OR t.team_id = $5::uuid)
              AND (NOT $6 OR (t.status = 'open' AND t.due_date < CURRENT_DATE))
              AND ($7::int IS NULL OR (t.due_date IS NOT NULL
                     AND t.due_date <= CURRENT_DATE + ($7::int || ' days')::interval))
            ORDER BY (t.status = 'done'),
                     (t.due_date IS NULL),
                     t.due_date,
                     CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                     t.created_at DESC
            """,
            target_tenant, me, owner_id, status, team_id, overdue_only, days,
        )
    return [_shape(r) for r in rows]


@router.get("/stats")
async def todo_stats(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Completion-rate reporting per individual and per team."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        by_owner = await conn.fetch(
            """
            SELECT COALESCE(u.name, 'Unassigned') AS name,
                   count(*) AS total,
                   count(*) FILTER (WHERE t.status = 'done') AS done,
                   count(*) FILTER (WHERE t.status = 'open' AND t.due_date < CURRENT_DATE) AS overdue
            FROM todos t LEFT JOIN users u ON u.id = t.owner_id
            WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
            GROUP BY u.name ORDER BY total DESC
            """,
            target,
        )
        by_team = await conn.fetch(
            """
            SELECT COALESCE(tm.name, 'No team') AS name,
                   count(*) AS total,
                   count(*) FILTER (WHERE t.status = 'done') AS done
            FROM todos t LEFT JOIN teams tm ON tm.id = t.team_id
            WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
            GROUP BY tm.name ORDER BY total DESC
            """,
            target,
        )

    def rate(rows):
        return [{**dict(r), "completion_rate": round(r["done"] / r["total"] * 100) if r["total"] else 0} for r in rows]

    return {"by_owner": rate(by_owner), "by_team": rate(by_team)}


@router.post("")
async def create_todo(body: NewTodoRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        row = await conn.fetchrow(
            """
            INSERT INTO todos (tenant_id, title, description, due_date, owner_id, team_id,
                               priority, is_private, source, issue_id, vcb_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, title, status, tenant_id
            """,
            body.tenant_id, body.title, body.description, body.due_date,
            body.owner_id or current_user.user_id, body.team_id, body.priority,
            body.is_private, body.source, body.issue_id, body.vcb_id,
        )
    return dict(row)


@router.patch("/{todo_id}")
async def update_todo(todo_id: str, body: UpdateTodoRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "todos", todo_id, "edit")
        # completed_at is stamped/cleared as status crosses done<->open
        row = await conn.fetchrow(
            """
            UPDATE todos SET
                title = COALESCE($2, title),
                description = COALESCE($3, description),
                due_date = COALESCE($4, due_date),
                owner_id = COALESCE($5, owner_id),
                team_id = COALESCE($6, team_id),
                priority = COALESCE($7, priority),
                status = COALESCE($8, status),
                completion_note = COALESCE($9, completion_note),
                issue_id = COALESCE($10, issue_id),
                vcb_id = COALESCE($11, vcb_id),
                completed_at = CASE
                    WHEN $8 = 'done' THEN now()
                    WHEN $8 = 'open' THEN NULL
                    ELSE completed_at END
            WHERE id = $1
            RETURNING id, title, status, tenant_id
            """,
            todo_id, body.title, body.description, body.due_date, body.owner_id, body.team_id,
            body.priority, body.status, body.completion_note, body.issue_id, body.vcb_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="To-Do not found or not accessible")
    return dict(row)


@router.post("/carry-forward")
async def carry_forward(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Weekly auto-carry-forward: flag every open, overdue to-do — bump its
    carried_count and log it — so incomplete items resurface in next week's
    meeting to-do segment instead of being silently dropped."""
    target = tenant_id or current_user.active_tenant_id
    if not target:
        raise HTTPException(status_code=400, detail="Pick a tenant to run carry-forward")
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, str(target), "edit")
        rows = await conn.fetch(
            "SELECT id FROM todos WHERE tenant_id = $1 AND status = 'open' AND due_date < CURRENT_DATE",
            target,
        )
        for r in rows:
            await conn.execute(
                "UPDATE todos SET carried_count = carried_count + 1, last_carried_at = now() WHERE id = $1",
                r["id"],
            )
            await conn.execute(
                "INSERT INTO carry_forward_log (todo_id, tenant_id, actor_id) VALUES ($1, $2, $3)",
                r["id"], target, current_user.user_id,
            )
    return {"carried": len(rows)}


@router.delete("/{todo_id}")
async def delete_todo(todo_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "todos", todo_id, "delete")
        result = await conn.execute("DELETE FROM todos WHERE id = $1", todo_id)
    return {"deleted": result}
