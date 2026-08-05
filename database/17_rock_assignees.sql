-- ============================================================================
-- Migration 17 — Rocks multi-assignee. A Rock can now be owned by several
-- people. rocks.owner_id stays as the PRIMARY owner (keeps RLS within-tenant
-- scoping + VCB rollup working unchanged); rock_assignees holds the full set.
-- Additive & re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rock_assignees (
    rock_id     UUID NOT NULL REFERENCES rocks(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    PRIMARY KEY (rock_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_rock_assignees_rock ON rock_assignees(rock_id);
CREATE INDEX IF NOT EXISTS idx_rock_assignees_tenant ON rock_assignees(tenant_id);

-- Same tenant-isolation shape as team_members.
ALTER TABLE rock_assignees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rock_assignees ON rock_assignees;
CREATE POLICY tenant_isolation_rock_assignees ON rock_assignees
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON rock_assignees TO hhcp_app;

-- Backfill: every existing rock's current owner becomes its first assignee.
INSERT INTO rock_assignees (rock_id, user_id, tenant_id)
SELECT r.id, r.owner_id, r.tenant_id
FROM rocks r
WHERE r.owner_id IS NOT NULL
ON CONFLICT (rock_id, user_id) DO NOTHING;
