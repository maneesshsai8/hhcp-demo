import uuid
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from datetime import date

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/organizations", tags=["organizations"])


class CreateOrgRequest(BaseModel):
    name: str
    tenant_type: str  # 'fund' | 'portco' | 'addon'
    parent_tenant_id: str | None = None
    fund_label: str | None = None
    acquisition_date: date | None = None
    transaction_type: str | None = None


class GrantRequest(BaseModel):
    user_id: str
    tenant_id: str
    role: str  # 'lead_partner' | 'deal_qb' | 'ops_qb' | 'portco_management' | 'addon_management'


async def _require_fund_admin(conn, user_id: str):
    is_admin = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM fund_roles WHERE user_id = $1 AND role = 'fund_admin')", user_id
    )
    if not is_admin:
        raise HTTPException(status_code=403, detail="Only Hidden Harbor fund admins can do this")


@router.get("")
async def list_organizations(current_user: CurrentUser = Depends(get_current_user)):
    """Everything the caller can see — RLS does the filtering, not this query."""
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, tenant_type, parent_tenant_id, fund_label,
                   acquisition_date, transaction_type, exit_date
            FROM organizations
            ORDER BY tenant_type, name
            """
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_organization(body: CreateOrgRequest, current_user: CurrentUser = Depends(get_current_user)):
    """PortCo Provisioning & Administration — Tier 1 admin only."""
    # Generate the id in the app rather than using RETURNING: user_accessible_tenants()
    # is STABLE, so under the INSERT statement's snapshot it can't yet see the row
    # we're creating, and a RETURNING clause would fail this table's own SELECT policy.
    new_id = uuid.uuid4()
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        parent = str(body.parent_tenant_id) if body.parent_tenant_id else None
        await conn.execute(
            """
            INSERT INTO organizations (id, name, tenant_type, parent_tenant_id, fund_label, acquisition_date, transaction_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            new_id, body.name, body.tenant_type, parent, body.fund_label,
            body.acquisition_date, body.transaction_type,
        )
    return {
        "id": str(new_id),
        "name": body.name,
        "tenant_type": body.tenant_type,
        "parent_tenant_id": parent,
    }


@router.get("/grants")
async def list_grants(current_user: CurrentUser = Depends(get_current_user)):
    """Every Tier 2 access grant, for the admin console. Admin only."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        rows = await conn.fetch(
            """
            SELECT tm.id, tm.role, u.name AS user_name, u.email AS user_email,
                   o.name AS tenant_name, o.tenant_type
            FROM tenant_memberships tm
            JOIN users u ON u.id = tm.user_id
            JOIN organizations o ON o.id = tm.tenant_id
            ORDER BY u.name, o.name
            """
        )
    return [dict(r) for r in rows]


@router.post("/grants")
async def grant_tenant_access(body: GrantRequest, current_user: CurrentUser = Depends(get_current_user)):
    """The 'hand out Tier 2 access' half of provisioning — also admin only."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        row = await conn.fetchrow(
            """
            INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
            RETURNING id, user_id, tenant_id, role
            """,
            body.user_id, body.tenant_id, body.role, current_user.user_id,
        )
    return dict(row)


@router.delete("/grants/{membership_id}")
async def revoke_tenant_access(membership_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Revoke access. Takes effect on the user's very next request (Option B)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        result = await conn.execute("DELETE FROM tenant_memberships WHERE id = $1", membership_id)
    return {"deleted": result}
