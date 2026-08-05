-- ============================================================================
-- Migration 09 — within-tenant, per-user record scoping for the generic tiers:
--   Read-Only     -> view-only (handled by the app permission matrix)
--   Team Member   -> sees only records they OWN (+ unowned/shared records)
--   Manager       -> sees their own records + their direct reports' records
-- This is a SECOND scoping layer on top of tenant isolation: a user still only
-- sees their accessible tenants, and now — if their role for that tenant is
-- team_member/manager — only the owned/report records within it.
-- Re-runnable.
-- ============================================================================

-- reporting hierarchy: who a user reports to (for Manager scope)
ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES users(id) ON DELETE SET NULL;

-- widen the grantable roles
ALTER TABLE tenant_memberships DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_role_check
    CHECK (role IN (
        'lead_partner', 'deal_qb', 'ops_qb', 'portco_management', 'addon_management',
        'deal_team', 'pog_member', 'manager', 'team_member', 'read_only'
    ));

-- can this user see a record in p_tenant owned by p_owner?
CREATE OR REPLACE FUNCTION user_can_see_record(p_user UUID, p_tenant UUID, p_owner UUID)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    r TEXT;
BEGIN
    IF p_user IS NULL THEN
        RETURN false;
    END IF;
    IF p_owner IS NULL THEN
        RETURN true;                        -- unowned = shared, everyone in tenant sees it
    END IF;

    r := user_role_for_tenant(p_user, p_tenant);

    IF r = 'team_member' THEN
        RETURN p_owner = p_user;            -- own records only
    ELSIF r = 'manager' THEN
        RETURN p_owner = p_user
            OR EXISTS (SELECT 1 FROM users u WHERE u.id = p_owner AND u.reports_to = p_user);
    ELSE
        RETURN true;                        -- all other roles see every record in the tenant
    END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION user_can_see_record(UUID, UUID, UUID) TO hhcp_app;

-- Re-create the owned-table policies to add the ownership check. The
-- owner column differs per table: kpis/rocks/todos = owner_id, issues = created_by.
DO $$
DECLARE
    t RECORD;
    acc TEXT := 'tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting(''app.current_user_id'', true)::uuid))';
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('kpis', 'owner_id'),
        ('rocks', 'owner_id'),
        ('todos', 'owner_id'),
        ('issues', 'created_by')
    ) AS x(tbl, owner_col) LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%s ON %I', t.tbl, t.tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_%s ON %I FOR ALL USING (%s AND user_can_see_record(current_setting(''app.current_user_id'', true)::uuid, tenant_id, %I)) WITH CHECK (%s AND user_can_see_record(current_setting(''app.current_user_id'', true)::uuid, tenant_id, %I))',
            t.tbl, t.tbl, acc, t.owner_col, acc, t.owner_col
        );
    END LOOP;
END $$;
