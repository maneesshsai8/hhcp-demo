from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_leadership, require_permission
from app import audit

router = APIRouter(prefix="/vcbs", tags=["vcbs"])


class NewVcbRequest(BaseModel):
    tenant_id: str
    title: str
    description: str | None = None
    investment_thesis: str | None = None
    outcome: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    workstreams: list[str] = []          # optional initial workstream names


class UpdateVcbRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    investment_thesis: str | None = None
    outcome: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    status: str | None = None            # 'on_track' | 'off_track' | 'complete'
    archived: bool | None = None


class NewWorkstreamRequest(BaseModel):
    name: str


class UpdateWorkstreamRequest(BaseModel):
    name: str | None = None
    sort_order: int | None = None


def _rollup(rocks: list[dict]) -> dict:
    """Roll Rock completion up into a progress % and a derived status."""
    total = len(rocks)
    complete = sum(1 for r in rocks if r["status"] == "complete")
    any_off = any(r["status"] == "off_track" for r in rocks)
    pct = round(complete / total * 100) if total else 0
    if total and complete == total:
        derived = "complete"
    elif any_off:
        derived = "off_track"
    else:
        derived = "on_track"
    return {"progress_pct": pct, "total_rocks": total, "complete_rocks": complete, "derived_status": derived}


@router.get("")
async def list_vcbs(
    tenant_id: str | None = Query(default=None),
    include_archived: bool = Query(default=False),
    current_user: CurrentUser = Depends(get_current_user),
):
    """VCB dashboard: every active VCB with its workstreams and a rolled-up
    progress % computed live from linked Rocks."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        vcbs = await conn.fetch(
            """
            SELECT v.id, v.tenant_id, v.title, v.description, v.investment_thesis, v.outcome,
                   v.start_date, v.end_date, v.status, v.archived,
                   o.name AS tenant_name, u.name AS created_by_name
            FROM vcbs v
            JOIN organizations o ON o.id = v.tenant_id
            LEFT JOIN users u ON u.id = v.created_by
            WHERE ($1::uuid IS NULL OR v.tenant_id = $1::uuid)
              AND ($2 OR NOT v.archived)
            ORDER BY v.archived, v.created_at DESC
            """,
            target, include_archived,
        )
        # workstreams for these VCBs
        ws = await conn.fetch(
            """
            SELECT w.id, w.vcb_id, w.name, w.sort_order
            FROM workstreams w
            WHERE ($1::uuid IS NULL OR w.tenant_id = $1::uuid)
            ORDER BY w.sort_order, w.created_at
            """,
            target,
        )
        # rocks that ladder up (with their workstream link)
        rocks = await conn.fetch(
            """
            SELECT r.id, r.title, r.status, r.due_date, r.workstream_id, r.tenant_id,
                   u.name AS owner_name
            FROM rocks r
            LEFT JOIN users u ON u.id = r.owner_id
            WHERE ($1::uuid IS NULL OR r.tenant_id = $1::uuid) AND r.workstream_id IS NOT NULL
            """,
            target,
        )

    rocks_by_ws: dict[str, list] = {}
    for r in rocks:
        rocks_by_ws.setdefault(str(r["workstream_id"]), []).append({
            "id": str(r["id"]), "title": r["title"], "status": r["status"],
            "due_date": r["due_date"].isoformat() if r["due_date"] else None,
            "owner_name": r["owner_name"],
        })

    ws_by_vcb: dict[str, list] = {}
    for w in ws:
        wr = rocks_by_ws.get(str(w["id"]), [])
        ws_by_vcb.setdefault(str(w["vcb_id"]), []).append({
            "id": str(w["id"]), "name": w["name"], "sort_order": w["sort_order"],
            "rocks": wr, **_rollup(wr),
        })

    out = []
    for v in vcbs:
        streams = ws_by_vcb.get(str(v["id"]), [])
        all_rocks = [r for s in streams for r in s["rocks"]]
        roll = _rollup(all_rocks)
        out.append({
            "id": str(v["id"]), "tenant_id": str(v["tenant_id"]), "tenant_name": v["tenant_name"],
            "title": v["title"], "description": v["description"],
            "investment_thesis": v["investment_thesis"], "outcome": v["outcome"],
            "start_date": v["start_date"].isoformat() if v["start_date"] else None,
            "end_date": v["end_date"].isoformat() if v["end_date"] else None,
            "status": v["status"], "archived": v["archived"],
            "created_by_name": v["created_by_name"],
            "workstreams": streams, **roll,
        })
    return out


@router.post("")
async def create_vcb(body: NewVcbRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_leadership(conn, current_user.user_id, body.tenant_id)
        row = await conn.fetchrow(
            """
            INSERT INTO vcbs (tenant_id, title, description, investment_thesis, outcome,
                              start_date, end_date, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, title, status
            """,
            body.tenant_id, body.title, body.description, body.investment_thesis, body.outcome,
            body.start_date, body.end_date, current_user.user_id,
        )
        for i, name in enumerate(body.workstreams):
            if name.strip():
                await conn.execute(
                    "INSERT INTO workstreams (vcb_id, tenant_id, name, sort_order) VALUES ($1, $2, $3, $4)",
                    row["id"], body.tenant_id, name.strip(), i,
                )
        await audit.log(conn, current_user.user_id, "vcb.create", entity_type="vcb",
                        entity_id=row["id"], tenant_id=body.tenant_id, detail=body.title)
    return {"id": str(row["id"]), "title": row["title"], "status": row["status"]}


@router.patch("/{vcb_id}")
async def update_vcb(vcb_id: str, body: UpdateVcbRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await conn.fetchval("SELECT tenant_id FROM vcbs WHERE id = $1", vcb_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="VCB not found or not accessible")
        await require_leadership(conn, current_user.user_id, str(tenant_id))
        before = await conn.fetchval("SELECT status FROM vcbs WHERE id = $1", vcb_id)
        row = await conn.fetchrow(
            """
            UPDATE vcbs SET
                title             = COALESCE($2, title),
                description       = COALESCE($3, description),
                investment_thesis = COALESCE($4, investment_thesis),
                outcome           = COALESCE($5, outcome),
                start_date        = COALESCE($6, start_date),
                end_date          = COALESCE($7, end_date),
                status            = COALESCE($8, status),
                archived          = COALESCE($9, archived)
            WHERE id = $1
            RETURNING id, title, status, archived
            """,
            vcb_id, body.title, body.description, body.investment_thesis, body.outcome,
            body.start_date, body.end_date, body.status, body.archived,
        )
        # Emit a status-change event (day-one feed for the Phase 2 compliance dashboard).
        if body.status and body.status != before:
            await audit.log(conn, current_user.user_id, "vcb.status", entity_type="vcb",
                            entity_id=vcb_id, tenant_id=str(tenant_id),
                            detail=f"{row['title']}: {before} → {body.status}")
        else:
            await audit.log(conn, current_user.user_id, "vcb.edit", entity_type="vcb",
                            entity_id=vcb_id, tenant_id=str(tenant_id), detail=row["title"])
    return {"id": str(row["id"]), "title": row["title"], "status": row["status"], "archived": row["archived"]}


@router.delete("/{vcb_id}")
async def delete_vcb(vcb_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await conn.fetchval("SELECT tenant_id FROM vcbs WHERE id = $1", vcb_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="VCB not found or not accessible")
        await require_leadership(conn, current_user.user_id, str(tenant_id))
        result = await conn.execute("DELETE FROM vcbs WHERE id = $1", vcb_id)
        await audit.log(conn, current_user.user_id, "vcb.delete", entity_type="vcb",
                        entity_id=vcb_id, tenant_id=str(tenant_id))
    return {"deleted": result}


# ---------------------------------------------------------------- workstreams --
@router.post("/{vcb_id}/workstreams")
async def add_workstream(vcb_id: str, body: NewWorkstreamRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await conn.fetchval("SELECT tenant_id FROM vcbs WHERE id = $1", vcb_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="VCB not found or not accessible")
        await require_leadership(conn, current_user.user_id, str(tenant_id))
        nxt = await conn.fetchval("SELECT COALESCE(MAX(sort_order)+1, 0) FROM workstreams WHERE vcb_id = $1", vcb_id)
        row = await conn.fetchrow(
            "INSERT INTO workstreams (vcb_id, tenant_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name",
            vcb_id, tenant_id, body.name, nxt,
        )
    return {"id": str(row["id"]), "name": row["name"]}


@router.patch("/workstreams/{ws_id}")
async def update_workstream(ws_id: str, body: UpdateWorkstreamRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await conn.fetchval("SELECT tenant_id FROM workstreams WHERE id = $1", ws_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="Workstream not found or not accessible")
        await require_leadership(conn, current_user.user_id, str(tenant_id))
        row = await conn.fetchrow(
            """UPDATE workstreams SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order)
               WHERE id = $1 RETURNING id, name""",
            ws_id, body.name, body.sort_order,
        )
    return {"id": str(row["id"]), "name": row["name"]}


@router.delete("/workstreams/{ws_id}")
async def delete_workstream(ws_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Deleting a workstream un-links its Rocks (ON DELETE SET NULL) — the Rocks survive."""
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await conn.fetchval("SELECT tenant_id FROM workstreams WHERE id = $1", ws_id)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="Workstream not found or not accessible")
        await require_leadership(conn, current_user.user_id, str(tenant_id))
        result = await conn.execute("DELETE FROM workstreams WHERE id = $1", ws_id)
    return {"deleted": result}
