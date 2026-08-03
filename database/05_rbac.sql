-- ============================================================================
-- Migration 05 — RBAC: resolve a user's EFFECTIVE role for a given tenant.
-- Access already cascades down the tree (user_accessible_tenants); this adds
-- the *role* dimension so we can enforce role->action permissions, not just
-- tenant visibility. Additive & re-runnable.
-- ============================================================================

-- Fund staff => 'fund_admin'. Otherwise walk up from the target tenant to the
-- first ancestor the user has an explicit grant on, and return THAT role
-- (so an add-on inherits the role from the PortCo grant that reaches it).
CREATE OR REPLACE FUNCTION user_role_for_tenant(p_user UUID, p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cur UUID := p_tenant;
    r   TEXT;
BEGIN
    IF p_user IS NULL OR p_tenant IS NULL THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM fund_roles fr WHERE fr.user_id = p_user) THEN
        RETURN 'fund_admin';
    END IF;

    WHILE cur IS NOT NULL LOOP
        SELECT tm.role INTO r
        FROM tenant_memberships tm
        WHERE tm.user_id = p_user AND tm.tenant_id = cur
        LIMIT 1;

        IF r IS NOT NULL THEN
            RETURN r;
        END IF;

        SELECT o.parent_tenant_id INTO cur FROM organizations o WHERE o.id = cur;
    END LOOP;

    RETURN NULL;  -- no access
END;
$$;

GRANT EXECUTE ON FUNCTION user_role_for_tenant(UUID, UUID) TO hhcp_app;
