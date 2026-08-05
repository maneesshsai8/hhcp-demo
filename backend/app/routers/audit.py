from fastapi import APIRouter, HTTPException, Depends, Query

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
async def list_audit(
    actor_id: str | None = Query(default=None),
    action: str | None = Query(default=None),
    limit: int = Query(default=200, le=1000),
    current_user: CurrentUser = Depends(get_current_user),
):
    """The compliance audit trail — fund-admin only. Filterable by user and action."""
    async with get_scoped_connection(current_user.user_id) as conn:
        ok = await conn.fetchval(
            "SELECT COALESCE(is_fund_admin, false) OR COALESCE(is_fund_viewer, false) FROM users WHERE id = $1",
            current_user.user_id,
        )
        if not ok:
            raise HTTPException(status_code=403, detail="Fund-level access required to view the audit log")
        rows = await conn.fetch(
            """
            SELECT id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at
            FROM audit_log
            WHERE ($1::uuid IS NULL OR actor_id = $1::uuid)
              AND ($2::text IS NULL OR action = $2::text)
            ORDER BY created_at DESC
            LIMIT $3
            """,
            actor_id, action, limit,
        )
    return [dict(r) for r in rows]
