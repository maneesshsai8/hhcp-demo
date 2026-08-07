-- ============================================================================
-- Migration 34 — KPI Groups: named sections on the Scorecard (ninety.io-style).
-- A measurable with group_id = NULL falls into the implicit frequency group
-- ("Weekly KPIs" etc.); a group_id points it at a named section. Additive &
-- re-runnable. Follows the standard tenant-RLS pattern (check_isolation.py gate).
-- ============================================================================
CREATE TABLE IF NOT EXISTS kpi_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kpi_groups_tenant ON kpi_groups(tenant_id);

ALTER TABLE kpi_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_kpi_groups ON kpi_groups;
CREATE POLICY tenant_isolation_kpi_groups ON kpi_groups
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));
GRANT SELECT, INSERT, UPDATE, DELETE ON kpi_groups TO hhcp_app;

-- Ladder a measurable up to a group (nullable; ungrouped = implicit freq group).
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES kpi_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_kpis_group ON kpis(group_id);
