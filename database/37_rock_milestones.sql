-- ============================================================================
-- Migration 37 — Rock Milestones (ninety.io parity).
-- A Rock breaks into checkable milestones, each with an owner + due date.
-- "Milestone progress" (done/total) drives the progress bar on the Rocks list.
-- Same tenant-isolation shape as rock_assignees. Additive & re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rock_milestones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rock_id     UUID NOT NULL REFERENCES rocks(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    done        BOOLEAN NOT NULL DEFAULT FALSE,
    owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    due_date    DATE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rock_milestones_rock   ON rock_milestones(rock_id);
CREATE INDEX IF NOT EXISTS idx_rock_milestones_tenant ON rock_milestones(tenant_id);

ALTER TABLE rock_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rock_milestones ON rock_milestones;
CREATE POLICY tenant_isolation_rock_milestones ON rock_milestones
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON rock_milestones TO hhcp_app;
