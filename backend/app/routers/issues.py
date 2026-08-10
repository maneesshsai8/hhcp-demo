from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import audit

router = APIRouter(prefix="/issues", tags=["issues"])


class NewIssueRequest(BaseModel):
    tenant_id: str
    title: str
    description: str | None = None
    team_id: str | None = None
    owner_id: str | None = None
    priority: str | None = None       # 'low' | 'medium' | 'high'
    category: str | None = None
    vcb_id: str | None = None
    term: str = "short"               # 'short' | 'long'


class UpdateIssueRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None         # 'open' | 'solved' (labelled "Resolved" in UI)
    team_id: str | None = None
    owner_id: str | None = None
    priority: str | None = None
    category: str | None = None
    vcb_id: str | None = None
    resolution_note: str | None = None
    archived: bool | None = None


class ReorderRequest(BaseModel):
    order: list[str]                  # issue_ids in the desired priority order


@router.get("", response_model=None)
async def list_issues(
    tenant_id: str | None = Query(default=None),
    team_id: str | None = Query(default=None),
    status: str | None = Query(default=None),          # 'open' | 'solved'
    term: str | None = Query(default=None),            # 'short' | 'long'
    include_archived: bool = Query(default=False),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Company- and team-level issue list. Open issues come back in drag-ranked
    priority order; resolved ones most-recently-solved first."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT i.id, i.title, i.description, i.status, i.tenant_id, i.created_at, i.priority,
                   i.category, i.sort_order, i.resolution_note, i.solved_at, i.archived, i.term,
                   i.owner_id, i.team_id, i.vcb_id,
                   u.name AS created_by_name, o.name AS owner_name,
                   t.name AS team_name, v.title AS vcb_title
            FROM issues i
            LEFT JOIN users u ON u.id = i.created_by
            LEFT JOIN users o ON o.id = i.owner_id
            LEFT JOIN teams t ON t.id = i.team_id
            LEFT JOIN vcbs v ON v.id = i.vcb_id
            WHERE ($1::uuid IS NULL OR i.tenant_id = $1::uuid)
              AND ($2::uuid IS NULL OR i.team_id = $2::uuid)
              AND ($3::text IS NULL OR i.status = $3::text)
              AND ($4 OR NOT i.archived)
              AND ($5::text IS NULL OR i.term = $5::text)
            ORDER BY (i.status = 'solved'),
                     CASE WHEN i.status = 'open' THEN i.sort_order END,
                     i.solved_at DESC NULLS LAST
            """,
            target_tenant, team_id, status, include_archived, term,
        )
    return [dict(r) for r in rows]


@router.get("/stats")
async def issue_stats(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Resolution-velocity report: issues resolved per week (last 8 weeks),
    plus open/resolved counts and average days-to-resolve."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        totals = await conn.fetchrow(
            """
            SELECT count(*) FILTER (WHERE status = 'open') AS open,
                   count(*) FILTER (WHERE status = 'solved') AS solved,
                   avg(EXTRACT(EPOCH FROM (solved_at - created_at)) / 86400.0)
                       FILTER (WHERE status = 'solved') AS avg_days
            FROM issues
            WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
            """,
            target,
        )
        velocity = await conn.fetch(
            """
            SELECT to_char(date_trunc('week', solved_at), 'YYYY-MM-DD') AS week,
                   count(*) AS resolved
            FROM issues
            WHERE status = 'solved' AND solved_at > now() - interval '8 weeks'
              AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
            GROUP BY 1 ORDER BY 1
            """,
            target,
        )
    return {
        "open": totals["open"],
        "solved": totals["solved"],
        "avg_days_to_resolve": round(float(totals["avg_days"]), 1) if totals["avg_days"] is not None else None,
        "velocity": [dict(v) for v in velocity],
    }


@router.post("")
async def create_issue(body: NewIssueRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        # new issues rank to the top of the open list (highest priority)
        await conn.execute(
            "UPDATE issues SET sort_order = sort_order + 1 WHERE tenant_id = $1 AND status = 'open'",
            body.tenant_id,
        )
        row = await conn.fetchrow(
            """
            INSERT INTO issues (tenant_id, title, description, created_by, owner_id, team_id,
                                priority, category, vcb_id, term, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
            RETURNING id, title, status, tenant_id
            """,
            body.tenant_id, body.title, body.description, current_user.user_id,
            body.owner_id, body.team_id, body.priority, body.category, body.vcb_id,
            body.term if body.term in ("short", "long") else "short",
        )
    return dict(row)


@router.patch("/{issue_id}")
async def update_issue(issue_id: str, body: UpdateIssueRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit, resolve/reopen (stamping solved_at + resolution note), or archive."""
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "issues", issue_id, "edit")
        before = await conn.fetchval("SELECT status FROM issues WHERE id = $1", issue_id)
        row = await conn.fetchrow(
            """
            UPDATE issues SET
                title = COALESCE($2, title),
                description = COALESCE($3, description),
                status = COALESCE($4, status),
                team_id = COALESCE($5, team_id),
                owner_id = COALESCE($6, owner_id),
                priority = COALESCE($7, priority),
                category = COALESCE($8, category),
                vcb_id = COALESCE($9, vcb_id),
                resolution_note = COALESCE($10, resolution_note),
                archived = COALESCE($11, archived),
                solved_at = CASE
                    WHEN $4 = 'solved' THEN now()
                    WHEN $4 = 'open' THEN NULL
                    ELSE solved_at END
            WHERE id = $1
            RETURNING id, title, status, tenant_id
            """,
            issue_id, body.title, body.description, body.status, body.team_id, body.owner_id,
            body.priority, body.category, body.vcb_id, body.resolution_note, body.archived,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Issue not found or not accessible")
        if body.status and body.status != before:
            await audit.log(conn, current_user.user_id, "issue.status", entity_type="issue",
                            entity_id=issue_id, tenant_id=str(tenant_id),
                            detail=f"{row['title']}: {before} → {body.status}")
    return dict(row)


@router.post("/reorder")
async def reorder_issues(body: ReorderRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Persist drag-and-drop priority ranking. RLS ensures the caller can only
    touch issues they can edit."""
    async with get_scoped_connection(current_user.user_id) as conn:
        for idx, issue_id in enumerate(body.order):
            await conn.execute("UPDATE issues SET sort_order = $2 WHERE id = $1", issue_id, idx)
    return {"reordered": len(body.order)}


@router.delete("/{issue_id}")
async def delete_issue(issue_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "issues", issue_id, "delete")
        result = await conn.execute("DELETE FROM issues WHERE id = $1", issue_id)
    return {"deleted": result}
