from fastapi import APIRouter, Depends, Query, HTTPException, Response

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission
from app.routers.scorecards import fetch_scorecards
from app import reports

router = APIRouter(prefix="/reports", tags=["reports"])

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


async def _load(current_user, tenant_id):
    target = tenant_id or current_user.active_tenant_id
    if not target:
        raise HTTPException(status_code=400, detail="Pick a specific tenant to export")
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, target, "view")
        name = await conn.fetchval("SELECT name FROM organizations WHERE id = $1", target)
        data = await fetch_scorecards(conn, target)
    if not name:
        raise HTTPException(status_code=404, detail="Tenant not found or not accessible")
    return name, data


@router.get("/scorecard.xlsx")
async def scorecard_xlsx(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    name, data = await _load(current_user, tenant_id)
    content = reports.build_scorecard_xlsx(name, data)
    filename = f"scorecard-{name.lower().replace(' ', '-')}.xlsx"
    return Response(
        content=content,
        media_type=XLSX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/scorecard.pdf")
async def scorecard_pdf(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    name, data = await _load(current_user, tenant_id)
    content, engine = await reports.build_scorecard_pdf(name, data)
    filename = f"scorecard-{name.lower().replace(' ', '-')}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Report-Engine": engine,  # 'playwright' or 'fpdf2' — visible in the response
        },
    )


# ---- generic list exports: Rocks / Issues / To-Dos ------------------------
# (kind) -> (sheet title, columns [(header, key)], list SELECT)
_MODULES = {
    "rocks": (
        "Rocks",
        [("Title", "title"), ("Owner", "owner_name"), ("Team", "team_name"),
         ("Status", "status"), ("Due", "due_date"), ("Description", "description")],
        """
        SELECT r.title, r.status, r.due_date, r.description,
               u.name AS owner_name, t.name AS team_name
        FROM rocks r
        LEFT JOIN users u ON u.id = r.owner_id
        LEFT JOIN teams t ON t.id = r.team_id
        WHERE r.tenant_id = $1
        ORDER BY r.status, r.due_date
        """,
    ),
    "issues": (
        "Issues",
        [("Title", "title"), ("Status", "status"), ("Priority", "priority"),
         ("Team", "team_name"), ("Raised by", "created_by_name"), ("Description", "description")],
        """
        SELECT i.title, i.status, i.priority, i.description,
               u.name AS created_by_name, t.name AS team_name
        FROM issues i
        LEFT JOIN users u ON u.id = i.created_by
        LEFT JOIN teams t ON t.id = i.team_id
        WHERE i.tenant_id = $1
        ORDER BY i.status, i.created_at DESC
        """,
    ),
    "todos": (
        "To-Dos",
        [("Title", "title"), ("Owner", "owner_name"), ("Team", "team_name"),
         ("Status", "status"), ("Due", "due_date"), ("Description", "description")],
        """
        SELECT t.title, t.status, t.due_date, t.description,
               u.name AS owner_name, tm.name AS team_name
        FROM todos t
        LEFT JOIN users u ON u.id = t.owner_id
        LEFT JOIN teams tm ON tm.id = t.team_id
        WHERE t.tenant_id = $1
        ORDER BY t.status, t.due_date NULLS LAST, t.created_at DESC
        """,
    ),
}


async def _load_list(current_user, tenant_id, kind):
    if kind not in _MODULES:
        raise HTTPException(status_code=404, detail="Unknown report")
    title, columns, sql = _MODULES[kind]
    target = tenant_id or current_user.active_tenant_id
    if not target:
        raise HTTPException(status_code=400, detail="Pick a specific tenant to export")
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, target, "view")
        name = await conn.fetchval("SELECT name FROM organizations WHERE id = $1", target)
        rows = [dict(r) for r in await conn.fetch(sql, target)]
    if not name:
        raise HTTPException(status_code=404, detail="Tenant not found or not accessible")
    return name, title, columns, rows


@router.get("/{kind}.xlsx")
async def list_xlsx(kind: str, tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    name, title, columns, rows = await _load_list(current_user, tenant_id, kind)
    content = reports.build_table_xlsx(title, f"{title} — {name}", columns, rows)
    return Response(
        content=content,
        media_type=XLSX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{kind}-{name.lower().replace(" ", "-")}.xlsx"'},
    )


@router.get("/{kind}.pdf")
async def list_pdf(kind: str, tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    name, title, columns, rows = await _load_list(current_user, tenant_id, kind)
    content, engine = await reports.build_table_pdf(f"{title} — {name}", columns, rows)
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{kind}-{name.lower().replace(" ", "-")}.pdf"',
            "X-Report-Engine": engine,
        },
    )
