from fastapi import APIRouter, Depends, Query

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app import schemas

router = APIRouter(prefix="/directory", tags=["directory"])


@router.get("", response_model=list[schemas.Person])
async def directory(
    tenant_id: str | None = Query(default=None),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Users the caller can assign work to — powers the Owner dropdowns in the
    create modals. Returns yourself plus everyone who holds a grant (or sits on a
    team) in any tenant you can access, via the SECURITY DEFINER helper
    assignable_users(). That function is the ONLY sanctioned way to see across the
    private tenant_memberships roster: it never exposes memberships for tenants
    you can't already reach, so a PortCo user still can't learn about users
    outside their own tenants — but co-workers in the SAME PortCo now show up.

    Scoped to the active tenant: when a specific PortCo is selected, the dropdown
    lists only that tenant's members. `tenant_id` (query param) wins; otherwise
    the caller's active tenant is used; null (rollup mode) returns everyone
    accessible.
    """
    scope = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            "SELECT id, name, email FROM assignable_users($1::uuid, $2::uuid)",
            current_user.user_id, scope,
        )
    return [dict(r) for r in rows]
