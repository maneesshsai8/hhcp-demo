-- ============================================================================
-- Migration 07 — collapse fund_roles into a boolean users.is_fund_admin.
-- Only 'fund_admin' was ever used, and a user has at most one fund role, so a
-- flag on users models it faithfully with less machinery. Additive & re-runnable.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_fund_admin boolean NOT NULL DEFAULT false;

-- Backfill from the old table if it's still present.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'fund_roles') THEN
        UPDATE users u SET is_fund_admin = true
        WHERE EXISTS (SELECT 1 FROM fund_roles fr WHERE fr.user_id = u.id AND fr.role = 'fund_admin');
    END IF;
END $$;

-- Redefine the two authorization functions to read the flag instead of the table.
CREATE OR REPLACE FUNCTION user_accessible_tenants(p_user_id UUID)
RETURNS TABLE(tenant_id UUID)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RETURN;
    END IF;

    IF (SELECT u.is_fund_admin FROM users u WHERE u.id = p_user_id) THEN
        RETURN QUERY SELECT o.id FROM organizations o;   -- Tier 1: whole portfolio
        RETURN;
    END IF;

    RETURN QUERY
    WITH RECURSIVE granted AS (
        SELECT tm.tenant_id AS id FROM tenant_memberships tm WHERE tm.user_id = p_user_id
    ),
    tree AS (
        SELECT id FROM granted
        UNION ALL
        SELECT o.id FROM organizations o JOIN tree t ON o.parent_tenant_id = t.id
    )
    SELECT DISTINCT id FROM tree;
END;
$$;

CREATE OR REPLACE FUNCTION user_role_for_tenant(p_user UUID, p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    cur UUID := p_tenant;
    r   TEXT;
BEGIN
    IF p_user IS NULL OR p_tenant IS NULL THEN
        RETURN NULL;
    END IF;

    IF (SELECT u.is_fund_admin FROM users u WHERE u.id = p_user) THEN
        RETURN 'fund_admin';
    END IF;

    WHILE cur IS NOT NULL LOOP
        SELECT tm.role INTO r FROM tenant_memberships tm
        WHERE tm.user_id = p_user AND tm.tenant_id = cur LIMIT 1;
        IF r IS NOT NULL THEN
            RETURN r;
        END IF;
        SELECT o.parent_tenant_id INTO cur FROM organizations o WHERE o.id = cur;
    END LOOP;

    RETURN NULL;
END;
$$;

-- The one RLS policy that referenced fund_roles directly.
DROP POLICY IF EXISTS tenant_isolation_memberships ON tenant_memberships;
CREATE POLICY tenant_isolation_memberships ON tenant_memberships
    FOR ALL
    USING (
        user_id = current_setting('app.current_user_id', true)::uuid
        OR (SELECT u.is_fund_admin FROM users u WHERE u.id = current_setting('app.current_user_id', true)::uuid)
    );

-- Nothing references it anymore — drop it.
DROP TABLE IF EXISTS fund_roles;
