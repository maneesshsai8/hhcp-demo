from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_leadership

router = APIRouter(prefix="/vision", tags=["vision"])


class VisionRequest(BaseModel):
    tenant_id: str
    mission: str | None = None
    vision: str | None = None
    core_values: str | None = None


@router.get("")
async def get_vision(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """The tenant's Vision page — readable by anyone who can see the tenant (RLS)."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """SELECT mission, vision, core_values, updated_at,
                      (SELECT name FROM users WHERE id = v.updated_by) AS updated_by_name
               FROM vision_documents v WHERE tenant_id = $1""",
            target,
        )
    return dict(row) if row else {"mission": None, "vision": None, "core_values": None,
                                  "updated_at": None, "updated_by_name": None}


@router.put("")
async def set_vision(body: VisionRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Publish/update the Vision page. Leadership only (Admin / Lead Partner / Deal QB /
    PortCo Management) — managers and team members are read-only."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_leadership(conn, current_user.user_id, body.tenant_id)
        await conn.execute(
            """
            INSERT INTO vision_documents (tenant_id, mission, vision, core_values, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (tenant_id) DO UPDATE SET
                mission = EXCLUDED.mission,
                vision = EXCLUDED.vision,
                core_values = EXCLUDED.core_values,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            """,
            body.tenant_id, body.mission, body.vision, body.core_values, current_user.user_id,
        )
    return {"saved": True}
