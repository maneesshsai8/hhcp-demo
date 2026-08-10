-- ============================================================================
-- Migration 14 — assignable_users(): the Owner-dropdown / directory source.
--
-- Problem: /directory discovered co-workers via the tenant_memberships table,
-- but that table's RLS is intentionally private (a non-admin sees only their
-- OWN grant row). So a PortCo user could never assign work to a co-worker who
-- happened not to share a team with them — the dropdown collapsed to just self.
--
-- Fix: a SECURITY DEFINER function that returns everyone who holds a grant in a
-- tenant the caller can access (via user_accessible_tenants), plus the caller,
-- plus their teammates — WITHOUT exposing the raw membership roster. It only
-- ever returns id/name/email, and only for tenants the caller already sees.
-- Additive & re-runnable.
-- ============================================================================

CREATE OR REPLACE FUNCTION assignable_users(p_user_id UUID)
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
        -- anyone with a grant in a tenant you can reach (fund admins reach all)
        OR u.id IN (
            SELECT tm.user_id
            FROM tenant_memberships tm
            WHERE tm.tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(p_user_id))
        )
        -- anyone on a team inside a tenant you can reach
        OR u.id IN (
            SELECT t.user_id
            FROM team_members t
            JOIN teams tt ON tt.id = t.team_id
            WHERE tt.tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(p_user_id))
        )
      )
    ORDER BY u.name
$$;

GRANT EXECUTE ON FUNCTION assignable_users(UUID) TO hhcp_app;
