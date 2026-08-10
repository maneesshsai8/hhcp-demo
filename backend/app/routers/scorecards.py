from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from datetime import datetime

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import schemas, audit

router = APIRouter(prefix="/scorecards", tags=["scorecards"])


class NewScoreRequest(BaseModel):
    recorded_at: datetime
    actual_value: float


class BulkScoreEntry(BaseModel):
    kpi_id: str
    recorded_at: datetime
    actual_value: float


class BulkScoreRequest(BaseModel):
    entries: list[BulkScoreEntry]


class NewKpiRequest(BaseModel):
    tenant_id: str
    title: str
    target_value: float                       # the goal / green target
    green_threshold: float | None = None      # meets-goal cutoff (defaults to target)
    red_threshold: float | None = None        # below this is red (defaults to target)
    direction: str = "higher_is_better"       # 'higher_is_better' | 'lower_is_better'
    frequency: str = "weekly"                 # 'weekly' | 'monthly'
    unit: str = "units"
    description: str | None = None
    owner_id: str | None = None
    group_id: str | None = None                # optional KPI group section
    team_id: str | None = None                 # optional owning team


class UpdateKpiRequest(BaseModel):
    title: str | None = None
    target_value: float | None = None
    green_threshold: float | None = None
    red_threshold: float | None = None
    direction: str | None = None
    frequency: str | None = None
    unit: str | None = None
    description: str | None = None
    owner_id: str | None = None
    sort_order: int | None = None
    group_id: str | None = None                # explicitly sent = move group (null = default)
    team_id: str | None = None                 # explicitly sent = (re)assign team (null = no team)
    archived: bool | None = None               # explicitly sent = archive / restore


class ReorderRequest(BaseModel):
    order: list[str]                          # kpi_ids in the desired display order


class NewGroupRequest(BaseModel):
    tenant_id: str
    name: str
    description: str | None = None


class UpdateGroupRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    sort_order: int | None = None


class MoveKpiRequest(BaseModel):
    group_id: str | None = None               # null => move back to the implicit freq group


def _rag(direction: str, actual: float, green: float, red: float) -> str:
    """Direction-aware Red/Yellow/Green. The yellow band is between the two
    thresholds; when green == red it collapses to a binary GREEN/RED."""
    if direction == "lower_is_better":
        if actual <= green:
            return "GREEN"
        if actual > red:
            return "RED"
        return "YELLOW"
    # higher_is_better
    if actual >= green:
        return "GREEN"
    if actual < red:
        return "RED"
    return "YELLOW"


def _op_for(direction: str) -> str:
    """Keep the legacy comparison_operator column in sync for exports/back-compat."""
    return "<=" if direction == "lower_is_better" else ">="


@router.get("", response_model=list[schemas.Scorecard])
async def get_scorecards(
    tenant_id: str | None = Query(default=None),
    frequency: str | None = Query(default=None),  # optional 'weekly'/'monthly' filter
    archived: bool = Query(default=False),         # False = active scorecard; True = Archived view
    team_id: str | None = Query(default=None),     # optional team filter ("measurables by team")
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Note the query below has NO tenant filter written anywhere in it. If the
    caller passes a tenant_id they don't have access to, RLS silently
    returns zero rows for it — same defense whether or not the app code
    remembers to check.
    """
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        return await fetch_scorecards(conn, target_tenant, frequency, archived, team_id)


async def fetch_scorecards(conn, target_tenant, frequency=None, archived=False, team_id=None):
    """Shared scorecard shaping used by the JSON endpoint and the Excel/PDF exports."""
    kpis = await conn.fetch(
        """
        SELECT k.id, k.title, k.description, k.frequency, k.direction,
               k.target_value, k.green_threshold, k.red_threshold, k.comparison_operator,
               k.unit, k.sort_order, u.name AS owner_name, k.owner_id, k.tenant_id, k.group_id,
               k.archived, k.team_id, t.name AS team_name
        FROM kpis k
        LEFT JOIN users u ON u.id = k.owner_id
        LEFT JOIN teams t ON t.id = k.team_id
        WHERE ($1::uuid IS NULL OR k.tenant_id = $1::uuid)
          AND ($2::text IS NULL OR k.frequency = $2::text)
          AND k.archived = $3::bool
          AND ($4::uuid IS NULL OR k.team_id = $4::uuid)
        ORDER BY k.sort_order, k.title
        """,
        target_tenant, frequency, archived, team_id,
    )

    result = []
    for k in kpis:
        goal = float(k["target_value"])
        green = float(k["green_threshold"]) if k["green_threshold"] is not None else goal
        red = float(k["red_threshold"]) if k["red_threshold"] is not None else goal
        direction = k["direction"] or "higher_is_better"

        scores = await conn.fetch(
            """
            SELECT recorded_at, actual_value
            FROM kpi_scores
            WHERE kpi_id = $1
            ORDER BY recorded_at DESC
            LIMIT 13
            """,
            k["id"],
        )
        weekly = []
        for s in scores:
            val = float(s["actual_value"])
            rag = _rag(direction, val, green, red)
            weekly.append({
                "week_ending": s["recorded_at"].date().isoformat(),
                "actual_value": val,
                "rag": rag,
                # legacy field kept for older consumers: only GREEN counts as on-track
                "status": "ON_TRACK" if rag == "GREEN" else "OFF_TRACK",
            })

        # most-recent-first from the query -> red streak counts from index 0
        red_streak = 0
        for w in weekly:
            if w["rag"] == "RED":
                red_streak += 1
            else:
                break

        result.append({
            "kpi_id": str(k["id"]),
            "title": k["title"],
            "description": k["description"],
            "frequency": k["frequency"] or "weekly",
            "direction": direction,
            "owner": k["owner_name"],
            "owner_id": str(k["owner_id"]) if k["owner_id"] else None,
            "target_value": goal,
            "green_threshold": green,
            "red_threshold": red,
            "comparison_operator": k["comparison_operator"],
            "unit": k["unit"],
            "sort_order": k["sort_order"],
            "tenant_id": str(k["tenant_id"]),
            "group_id": str(k["group_id"]) if k["group_id"] else None,
            "team_id": str(k["team_id"]) if k["team_id"] else None,
            "team_name": k["team_name"],
            "archived": k["archived"],
            "weekly_history": list(reversed(weekly)),  # chronological for charting
            "current_rag": weekly[0]["rag"] if weekly else None,
            "off_track_streak": red_streak,
        })
    return result


@router.post("")
async def create_kpi(body: NewKpiRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Create a new measurable. RLS's WITH CHECK refuses tenants you can't see."""
    green = body.green_threshold if body.green_threshold is not None else body.target_value
    red = body.red_threshold if body.red_threshold is not None else body.target_value
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        next_order = await conn.fetchval(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM kpis WHERE tenant_id = $1", body.tenant_id
        )
        row = await conn.fetchrow(
            """
            INSERT INTO kpis (tenant_id, title, description, owner_id, target_value,
                              green_threshold, red_threshold, direction, frequency,
                              comparison_operator, unit, sort_order, group_id, team_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id, title
            """,
            body.tenant_id, body.title, body.description, body.owner_id or current_user.user_id,
            body.target_value, green, red, body.direction, body.frequency,
            _op_for(body.direction), body.unit, next_order, body.group_id, body.team_id,
        )
        await audit.log(conn, current_user.user_id, "scorecard.kpi_create", entity_type="kpi",
                        entity_id=row["id"], tenant_id=body.tenant_id, detail=body.title)
    return dict(row)


@router.patch("/{kpi_id}")
async def update_kpi(kpi_id: str, body: UpdateKpiRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit a KPI's definition. COALESCE keeps unspecified fields unchanged.
    Editing a threshold does NOT rewrite past history — kpi_scores is untouched;
    only how future/re-rendered RAG is computed changes."""
    op = _op_for(body.direction) if body.direction else None
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "kpis", kpi_id, "edit")
        row = await conn.fetchrow(
            """
            UPDATE kpis SET
                title               = COALESCE($2, title),
                target_value        = COALESCE($3, target_value),
                green_threshold     = COALESCE($4, green_threshold),
                red_threshold       = COALESCE($5, red_threshold),
                direction           = COALESCE($6, direction),
                frequency           = COALESCE($7, frequency),
                unit                = COALESCE($8, unit),
                description         = COALESCE($9, description),
                owner_id            = COALESCE($10, owner_id),
                sort_order          = COALESCE($11, sort_order),
                comparison_operator = COALESCE($12, comparison_operator)
            WHERE id = $1
            RETURNING id, title, tenant_id
            """,
            kpi_id, body.title, body.target_value, body.green_threshold, body.red_threshold,
            body.direction, body.frequency, body.unit, body.description, body.owner_id,
            body.sort_order, op,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="KPI not found or not accessible")
        # group_id is applied only when explicitly present in the payload, so a
        # PATCH that omits it never disturbs the KPI's group; sending null moves
        # it back to the default section. (COALESCE can't express "set to null".)
        if "group_id" in body.model_fields_set:
            await conn.execute("UPDATE kpis SET group_id = $2 WHERE id = $1", kpi_id, body.group_id)
        # team_id / archived: same explicit-presence rule so an omitted field is
        # never disturbed (COALESCE can't express "set to null" / "set to false").
        if "team_id" in body.model_fields_set:
            await conn.execute("UPDATE kpis SET team_id = $2 WHERE id = $1", kpi_id, body.team_id)
        if "archived" in body.model_fields_set:
            await conn.execute("UPDATE kpis SET archived = $2 WHERE id = $1", kpi_id, body.archived)
        await audit.log(conn, current_user.user_id, "scorecard.kpi_edit", entity_type="kpi",
                        entity_id=kpi_id, tenant_id=str(row["tenant_id"]), detail=row["title"])
    return {"id": str(row["id"]), "title": row["title"]}


# ---------------------------------------------------------------------------
# KPI Groups — ninety.io-style scorecard sections
# ---------------------------------------------------------------------------
@router.get("/groups")
async def list_groups(tenant_id: str | None = Query(default=None),
                      current_user: CurrentUser = Depends(get_current_user)):
    """List the tenant's KPI groups. RLS scopes visibility; no explicit filter."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """SELECT id, tenant_id, name, description, sort_order
               FROM kpi_groups
               WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
               ORDER BY sort_order, name""",
            target,
        )
    return [{"id": str(r["id"]), "tenant_id": str(r["tenant_id"]), "name": r["name"],
             "description": r["description"], "sort_order": r["sort_order"]} for r in rows]


@router.post("/groups")
async def create_group(body: NewGroupRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        next_order = await conn.fetchval(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM kpi_groups WHERE tenant_id = $1", body.tenant_id
        )
        row = await conn.fetchrow(
            """INSERT INTO kpi_groups (tenant_id, name, description, sort_order, created_by)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, name""",
            body.tenant_id, body.name, body.description, next_order, current_user.user_id,
        )
        await audit.log(conn, current_user.user_id, "scorecard.group_create", entity_type="kpi_group",
                        entity_id=row["id"], tenant_id=body.tenant_id, detail=body.name)
    return {"id": str(row["id"]), "name": row["name"]}


@router.patch("/groups/{group_id}")
async def update_group(group_id: str, body: UpdateGroupRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        existing = await conn.fetchrow("SELECT tenant_id FROM kpi_groups WHERE id = $1", group_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Group not found or not accessible")
        await require_permission(conn, current_user.user_id, str(existing["tenant_id"]), "edit")
        row = await conn.fetchrow(
            """UPDATE kpi_groups SET
                 name        = COALESCE($2, name),
                 description = COALESCE($3, description),
                 sort_order  = COALESCE($4, sort_order)
               WHERE id = $1 RETURNING id, name""",
            group_id, body.name, body.description, body.sort_order,
        )
    return {"id": str(row["id"]), "name": row["name"]}


@router.delete("/groups/{group_id}")
async def delete_group(group_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Delete a group; its measurables fall back to the implicit frequency
    group via the FK's ON DELETE SET NULL — no measurables are lost."""
    async with get_scoped_connection(current_user.user_id) as conn:
        existing = await conn.fetchrow("SELECT tenant_id FROM kpi_groups WHERE id = $1", group_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Group not found or not accessible")
        await require_permission(conn, current_user.user_id, str(existing["tenant_id"]), "delete")
        await conn.execute("DELETE FROM kpi_groups WHERE id = $1", group_id)
    return {"ok": True}


@router.patch("/{kpi_id}/group")
async def move_kpi_to_group(kpi_id: str, body: MoveKpiRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Move a measurable into a group (or back to the implicit group when null)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "kpis", kpi_id, "edit")
        row = await conn.fetchrow(
            "UPDATE kpis SET group_id = $2 WHERE id = $1 RETURNING id", kpi_id, body.group_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="KPI not found or not accessible")
    return {"id": str(row["id"]), "group_id": body.group_id}


@router.post("/reorder")
async def reorder_kpis(body: ReorderRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Persist drag-to-reorder. RLS ensures a caller can only touch KPIs they can edit."""
    async with get_scoped_connection(current_user.user_id) as conn:
        for idx, kpi_id in enumerate(body.order):
            await conn.execute("UPDATE kpis SET sort_order = $2 WHERE id = $1", kpi_id, idx)
    return {"reordered": len(body.order)}


@router.delete("/{kpi_id}")
async def delete_kpi(kpi_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "kpis", kpi_id, "delete")
        result = await conn.execute("DELETE FROM kpis WHERE id = $1", kpi_id)
    return {"deleted": result}


async def _record_score(conn, current_user, kpi_id, recorded_at, actual_value):
    """Append one immutable data point, emit a scorecard-update event, and run the
    auto-issue check. Returns the id of any auto-created Issue (or None)."""
    kpi = await conn.fetchrow(
        """SELECT tenant_id, title, target_value, green_threshold, red_threshold,
                  direction, owner_id FROM kpis WHERE id = $1""",
        kpi_id,
    )
    if kpi is None:
        raise HTTPException(status_code=404, detail="KPI not found or not accessible")

    await require_permission(conn, current_user.user_id, str(kpi["tenant_id"]), "create")

    # Upsert: re-entering a period that already has a score updates it in place
    # instead of colliding on the (kpi_id, recorded_at) primary key.
    await conn.execute(
        """INSERT INTO kpi_scores (tenant_id, kpi_id, recorded_at, actual_value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (kpi_id, recorded_at) DO UPDATE SET actual_value = EXCLUDED.actual_value""",
        kpi["tenant_id"], kpi_id, recorded_at, actual_value,
    )

    goal = float(kpi["target_value"])
    green = float(kpi["green_threshold"]) if kpi["green_threshold"] is not None else goal
    red = float(kpi["red_threshold"]) if kpi["red_threshold"] is not None else goal
    rag = _rag(kpi["direction"] or "higher_is_better", float(actual_value), green, red)

    # Emit a scorecard-update event from day one — this audit_log feed is what the
    # Phase 2 OS Compliance Dashboard will consume.
    await audit.log(conn, current_user.user_id, "scorecard.entry", entity_type="kpi",
                    entity_id=kpi_id, tenant_id=str(kpi["tenant_id"]),
                    detail=f"{kpi['title']} = {actual_value} → {rag}")

    # Auto-create an Issue after 3 consecutive RED periods (Phase 2 preview).
    recent = await conn.fetch(
        "SELECT actual_value FROM kpi_scores WHERE kpi_id = $1 ORDER BY recorded_at DESC LIMIT 3",
        kpi_id,
    )
    three_red = len(recent) == 3 and all(
        _rag(kpi["direction"] or "higher_is_better", float(r["actual_value"]), green, red) == "RED"
        for r in recent
    )

    auto_issue = None
    if three_red:
        title = f"{kpi['title']} off-track 3 periods running"
        existing = await conn.fetchval(
            "SELECT 1 FROM issues WHERE tenant_id = $1 AND title = $2 AND status = 'open'",
            kpi["tenant_id"], title,
        )
        if not existing:
            new = await conn.fetchrow(
                """INSERT INTO issues (tenant_id, title, description, status, created_by)
                   VALUES ($1, $2, $3, 'open', $4) RETURNING id""",
                kpi["tenant_id"], title,
                "Auto-created: this metric has been red 3 periods in a row.", kpi["owner_id"],
            )
            auto_issue = str(new["id"])
    return {"rag": rag, "auto_created_issue_id": auto_issue}


@router.post("/{kpi_id}/scores")
async def add_score(kpi_id: str, body: NewScoreRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Record a value for a period. One score per (kpi, recorded_at): a new period
    appends, re-entering an existing period updates that cell (upsert). Editing a
    goal/threshold still never rewrites stored values — only how RAG is computed."""
    async with get_scoped_connection(current_user.user_id) as conn:
        res = await _record_score(conn, current_user, kpi_id, body.recorded_at, body.actual_value)
    return {"inserted": True, **res}


@router.post("/scores/bulk")
async def add_scores_bulk(body: BulkScoreRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Bulk data entry — one round-trip to update this period across many KPIs."""
    inserted, auto_issues = 0, []
    async with get_scoped_connection(current_user.user_id) as conn:
        for e in body.entries:
            res = await _record_score(conn, current_user, e.kpi_id, e.recorded_at, e.actual_value)
            inserted += 1
            if res.get("auto_created_issue_id"):
                auto_issues.append(res["auto_created_issue_id"])
    return {"inserted": inserted, "auto_created_issue_ids": auto_issues}
