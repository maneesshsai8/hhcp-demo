"""
Role -> action permission matrix (RBAC). Access to a tenant is decided by RLS
(user_accessible_tenants); this layer decides what you may DO once you're in.

Effective role for a tenant is resolved by the SQL function
user_role_for_tenant() — fund staff are 'fund_admin' everywhere, everyone else
inherits the role of the nearest granted ancestor (so add-ons inherit the
PortCo grant's role).
"""
from fastapi import HTTPException

# Actions: view (read), create, edit, delete, provision (admin-only tenant/user/team mgmt)
ROLE_PERMISSIONS = {
    "fund_admin":        {"view", "create", "edit", "delete", "provision"},
    "lead_partner":      {"view", "create", "edit", "delete"},
    "deal_qb":           {"view", "create", "edit", "delete"},
    "portco_management": {"view", "create", "edit", "delete"},
    "ops_qb":            {"view", "create", "edit"},            # cannot delete
    "addon_management":  {"view", "create", "edit"},            # cannot delete
    "deal_team":         {"view", "create", "edit"},            # contributor, no delete
    "pog_member":        {"view"},                              # read-only observer
    "manager":           {"view", "create", "edit", "delete"},  # + data scoped to own + direct reports (RLS)
    "team_member":       {"view", "create", "edit"},            # + data scoped to own records (RLS)
    "read_only":         {"view"},                              # view-only
}


async def effective_role(conn, user_id: str, tenant_id: str) -> str | None:
    return await conn.fetchval("SELECT user_role_for_tenant($1, $2)", user_id, tenant_id)


async def require_permission(conn, user_id: str, tenant_id: str, action: str):
    """Raise 403 unless the user's effective role for this tenant allows `action`."""
    role = await effective_role(conn, user_id, tenant_id)
    if role is None or action not in ROLE_PERMISSIONS.get(role, set()):
        raise HTTPException(
            status_code=403,
            detail=f"Your role ({role or 'no access'}) is not allowed to {action} in this tenant",
        )
    return role


# VCBs are HHCP's strategic layer — only leadership defines them (Rocks below them
# are the manager/team layer). Everyone who can see the tenant can still VIEW a VCB.
LEADERSHIP_ROLES = {"fund_admin", "lead_partner", "deal_qb", "portco_management"}


async def require_leadership(conn, user_id: str, tenant_id: str):
    role = await effective_role(conn, user_id, tenant_id)
    if role not in LEADERSHIP_ROLES:
        raise HTTPException(
            status_code=403,
            detail=f"Only leadership (fund admin / lead partner / deal QB / portco management) can manage VCBs — your role is {role or 'no access'}",
        )
    return role


async def require_row_permission(conn, user_id: str, table: str, row_id: str, action: str):
    """
    For edit/delete: look up the row's tenant_id, then check `action`. RLS has
    already guaranteed the row is one the caller can see, so a missing row means
    404. `table` is an internal literal, never user input.
    """
    tenant_id = await conn.fetchval(f"SELECT tenant_id FROM {table} WHERE id = $1", row_id)
    if tenant_id is None:
        raise HTTPException(status_code=404, detail="Not found or not accessible")
    await require_permission(conn, user_id, str(tenant_id), action)
    return tenant_id
