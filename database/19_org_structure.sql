-- ============================================================================
-- Migration 19 — Org Structure / Accountability Chart upgrade:
-- GWC (Gets it / Wants it / Capacity) per seat, multiple person-to-role
-- assignments, drag-to-reorder, and chart version history. Additive & re-runnable.
-- (responsibilities stays TEXT — the UI treats it as up to 5 newline bullets.)
-- ============================================================================

ALTER TABLE seats ADD COLUMN IF NOT EXISTS gwc_gets     BOOLEAN;   -- null = not yet assessed
ALTER TABLE seats ADD COLUMN IF NOT EXISTS gwc_wants    BOOLEAN;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS gwc_capacity BOOLEAN;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS sort_order   INT NOT NULL DEFAULT 0;

-- Multiple people can hold the same role/seat. holder_user_id stays as the
-- PRIMARY holder (for the existing single-holder displays); seat_holders is the full set.
CREATE TABLE IF NOT EXISTS seat_holders (
    seat_id    UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    PRIMARY KEY (seat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_seat_holders_seat ON seat_holders(seat_id);
CREATE INDEX IF NOT EXISTS idx_seat_holders_tenant ON seat_holders(tenant_id);

ALTER TABLE seat_holders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_seat_holders ON seat_holders;
CREATE POLICY tenant_isolation_seat_holders ON seat_holders
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

-- Chart version history: a full JSONB snapshot each time the chart is published.
CREATE TABLE IF NOT EXISTS org_chart_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    label       TEXT,
    snapshot    JSONB NOT NULL,
    seat_count  INT NOT NULL DEFAULT 0,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chart_versions_tenant ON org_chart_versions(tenant_id, created_at DESC);

ALTER TABLE org_chart_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_chart_versions ON org_chart_versions;
CREATE POLICY tenant_isolation_chart_versions ON org_chart_versions
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON seat_holders TO hhcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_chart_versions TO hhcp_app;

-- Backfill: existing primary holder becomes the seat's first assignment.
INSERT INTO seat_holders (seat_id, user_id, tenant_id)
SELECT id, holder_user_id, tenant_id FROM seats WHERE holder_user_id IS NOT NULL
ON CONFLICT (seat_id, user_id) DO NOTHING;
