from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from datetime import datetime

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/scorecards", tags=["scorecards"])


class NewScoreRequest(BaseModel):
    recorded_at: datetime
    actual_value: float


class NewKpiRequest(BaseModel):
    tenant_id: str
    title: str
    target_value: float
    comparison_operator: str = ">="  # '>=', '<=', '='
    unit: str = "units"
    owner_id: str | None = None


class UpdateKpiRequest(BaseModel):
    title: str | None = None
    target_value: float | None = None
    comparison_operator: str | None = None
    unit: str | None = None
    owner_id: str | None = None


def _is_on_track(operator: str, actual: float, target: float) -> bool:
    if operator == ">=":
        return actual >= target
    if operator == "<=":
        return actual <= target
    return actual == target


@router.get("")
async def get_scorecards(
    tenant_id: str | None = Query(default=None),
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
        kpis = await conn.fetch(
            """
            SELECT k.id, k.title, k.target_value, k.comparison_operator, k.unit,
                   u.name AS owner_name, k.tenant_id
            FROM kpis k
            LEFT JOIN users u ON u.id = k.owner_id
            WHERE ($1::uuid IS NULL OR k.tenant_id = $1::uuid)
            ORDER BY k.title
            """,
            target_tenant,
        )

        result = []
        for k in kpis:
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
            weekly = [
                {
                    "week_ending": s["recorded_at"].date().isoformat(),
                    "actual_value": float(s["actual_value"]),
                    "status": "ON_TRACK" if _is_on_track(k["comparison_operator"], float(s["actual_value"]), float(k["target_value"])) else "OFF_TRACK",
                }
                for s in scores
            ]
            # most-recent-first from the query -> streak counts from index 0
            off_track_streak = 0
            for w in weekly:
                if w["status"] == "OFF_TRACK":
                    off_track_streak += 1
                else:
                    break

            result.append({
                "kpi_id": str(k["id"]),
                "title": k["title"],
                "owner": k["owner_name"],
                "target_value": float(k["target_value"]),
                "comparison_operator": k["comparison_operator"],
                "unit": k["unit"],
                "tenant_id": str(k["tenant_id"]),
                "weekly_history": list(reversed(weekly)),  # chronological for charting
                "off_track_streak": off_track_streak,
            })
    return result


@router.post("")
async def create_kpi(body: NewKpiRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Create a new measurable. RLS's WITH CHECK refuses tenants you can't see."""
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO kpis (tenant_id, title, owner_id, target_value, comparison_operator, unit)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, title
            """,
            body.tenant_id, body.title, body.owner_id or current_user.user_id,
            body.target_value, body.comparison_operator, body.unit,
        )
    return dict(row)


@router.patch("/{kpi_id}")
async def update_kpi(kpi_id: str, body: UpdateKpiRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit a KPI's definition. COALESCE keeps unspecified fields unchanged."""
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            UPDATE kpis SET
                title = COALESCE($2, title),
                target_value = COALESCE($3, target_value),
                comparison_operator = COALESCE($4, comparison_operator),
                unit = COALESCE($5, unit),
                owner_id = COALESCE($6, owner_id)
            WHERE id = $1
            RETURNING id, title
            """,
            kpi_id, body.title, body.target_value, body.comparison_operator, body.unit, body.owner_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="KPI not found or not accessible")
    return dict(row)


@router.delete("/{kpi_id}")
async def delete_kpi(kpi_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        result = await conn.execute("DELETE FROM kpis WHERE id = $1", kpi_id)
    return {"deleted": result}


@router.post("/{kpi_id}/scores")
async def add_score(kpi_id: str, body: NewScoreRequest, current_user: CurrentUser = Depends(get_current_user)):
    """
    Append a new weekly value. Never overwrites history — this is the
    'editing a goal shouldn't rewrite the past' requirement from the
    Foundation Tech Direction doc, achieved here with a plain indexed
    append-only table rather than a TimescaleDB hypertable (see README
    for why, given this sandbox's constraints).

    Bonus (explicitly a Phase 2 preview, not priced into Phase 1): if this
    makes 3 consecutive off-track weeks, auto-create an Issue — the exact
    logic sketched in the TimescaleDB technical doc.
    """
    async with get_scoped_connection(current_user.user_id) as conn:
        kpi = await conn.fetchrow(
            "SELECT tenant_id, title, target_value, comparison_operator, owner_id FROM kpis WHERE id = $1",
            kpi_id,
        )
        if kpi is None:
            raise HTTPException(status_code=404, detail="KPI not found or not accessible")

        await conn.execute(
            "INSERT INTO kpi_scores (tenant_id, kpi_id, recorded_at, actual_value) VALUES ($1, $2, $3, $4)",
            kpi["tenant_id"], kpi_id, body.recorded_at, body.actual_value,
        )

        recent = await conn.fetch(
            "SELECT actual_value FROM kpi_scores WHERE kpi_id = $1 ORDER BY recorded_at DESC LIMIT 3",
            kpi_id,
        )
        three_off_track = len(recent) == 3 and all(
            not _is_on_track(kpi["comparison_operator"], float(r["actual_value"]), float(kpi["target_value"]))
            for r in recent
        )

        auto_issue = None
        if three_off_track:
            existing = await conn.fetchval(
                """
                SELECT 1 FROM issues
                WHERE tenant_id = $1 AND title = $2 AND status = 'open'
                """,
                kpi["tenant_id"], f"{kpi['title']} off-track 3 weeks running",
            )
            if not existing:
                row = await conn.fetchrow(
                    """
                    INSERT INTO issues (tenant_id, title, description, status, created_by)
                    VALUES ($1, $2, $3, 'open', $4)
                    RETURNING id
                    """,
                    kpi["tenant_id"],
                    f"{kpi['title']} off-track 3 weeks running",
                    "Auto-created: this metric has missed its target 3 weeks in a row.",
                    kpi["owner_id"],
                )
                auto_issue = str(row["id"])

    return {"inserted": True, "auto_created_issue_id": auto_issue}
