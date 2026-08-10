-- ============================================================================
-- Migration 15 — assignable_users() scoped to the ACTIVE tenant.
--
-- Refinement of migration 14: when you're working inside a specific PortCo, the
-- Owner dropdown should list only that PortCo's members — not everyone across
-- every tenant you can reach. So the function now takes an optional p_tenant_id
-- (the caller's active tenant). When given, results are restricted to users
-- ALLOCATED to that exact tenant (a direct grant, or a team seat in it), plus
-- yourself. When null (e.g. fund-admin rollup mode), it falls back to the full
-- accessible set from migration 14.
--
-- Security: p_tenant_id is always intersected with user_accessible_tenants(caller),
-- so passing a tenant you can't reach yields just yourself — never a way to
-- enumerate a stranger tenant's roster.  Additive & re-runnable.
-- ============================================================================

CREATE OR REPLACE FUNCTION assignable_users(p_user_id UUID, p_tenant_id UUID DEFAULT NULL)
RETURNS TABLE(id UUID, name TEXT, email TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    WHERE u.is_active
      AND (
        -- always yourself
        u.id = p_user_id
        -- anyone with a grant in the scoped tenant (or any accessible tenant if unscoped)
        OR u.id IN (
            SELECT tm.user_id
            FROM tenant_memberships tm
            WHERE tm.tenant_id IN (
                SELECT tenant_id FROM user_accessible_tenants(p_user_id)
                WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id
            )
        )
        -- anyone on a team inside the scoped tenant
        OR u.id IN (
            SELECT t.user_id
            FROM team_members t
            JOIN teams tt ON tt.id = t.team_id
            WHERE tt.tenant_id IN (
                SELECT tenant_id FROM user_accessible_tenants(p_user_id)
                WHERE p_tenant_id IS NULL OR tenant_id = p_tenant_id
            )
        )
      )
    ORDER BY u.name
$$;

GRANT EXECUTE ON FUNCTION assignable_users(UUID, UUID) TO hhcp_app;
