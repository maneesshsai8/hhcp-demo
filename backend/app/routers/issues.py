from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/issues", tags=["issues"])


class NewIssueRequest(BaseModel):
    tenant_id: str
    title: str
    description: str | None = None
    team_id: str | None = None
    priority: str | None = None     # 'low' | 'medium' | 'high'


class UpdateIssueRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None       # 'open' | 'solved'
    team_id: str | None = None
    priority: str | None = None


@router.get("")
async def list_issues(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT i.id, i.title, i.description, i.status, i.tenant_id, i.created_at, i.priority,
                   u.name AS created_by_name, t.name AS team_name
            FROM issues i
            LEFT JOIN users u ON u.id = i.created_by
            LEFT JOIN teams t ON t.id = i.team_id
            WHERE ($1::uuid IS NULL OR i.tenant_id = $1::uuid)
            ORDER BY i.status, i.created_at DESC
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_issue(body: NewIssueRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO issues (tenant_id, title, description, created_by, team_id, priority)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, title, status, tenant_id
            """,
            body.tenant_id, body.title, body.description, current_user.user_id, body.team_id, body.priority,
        )
    return dict(row)


@router.patch("/{issue_id}")
async def update_issue(issue_id: str, body: UpdateIssueRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit or solve/reopen an issue. Sets solved_at when moving to 'solved'."""
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            UPDATE issues SET
                title = COALESCE($2, title),
                description = COALESCE($3, description),
                status = COALESCE($4, status),
                team_id = COALESCE($5, team_id),
                priority = COALESCE($6, priority),
                solved_at = CASE
                    WHEN $4 = 'solved' THEN now()
                    WHEN $4 = 'open' THEN NULL
                    ELSE solved_at
                END
            WHERE id = $1
            RETURNING id, title, status, tenant_id
            """,
            issue_id, body.title, body.description, body.status, body.team_id, body.priority,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Issue not found or not accessible")
    return dict(row)


@router.delete("/{issue_id}")
async def delete_issue(issue_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        result = await conn.execute("DELETE FROM issues WHERE id = $1", issue_id)
    return {"deleted": result}
