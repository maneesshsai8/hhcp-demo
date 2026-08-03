from fastapi import APIRouter, Depends

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/directory", tags=["directory"])


@router.get("")
async def directory(current_user: CurrentUser = Depends(get_current_user)):
    """
    Users the caller can assign work to — powers the Owner dropdowns in the
    create modals. Not admin-gated: returns yourself, anyone on a team in a
    tenant you can see, and (for fund admins, via RLS on tenant_memberships)
    everyone. The team_members / tenant_memberships subqueries are themselves
    RLS-scoped, so a PortCo user never learns about users outside their tenants.
    """
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT u.id, u.name, u.email
            FROM users u
            WHERE u.id = current_setting('app.current_user_id', true)::uuid
               OR u.id IN (SELECT user_id FROM team_members)
               OR u.id IN (SELECT user_id FROM tenant_memberships)
            ORDER BY u.name
            """
        )
    return [dict(r) for r in rows]
