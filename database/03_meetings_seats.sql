-- ============================================================================
-- Migration 03 — Meetings (L10) and Accountability Chart seats.
-- Additive & re-runnable. Same cascading tenant-isolation RLS as everything else.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- meetings: the weekly leadership (L10) meetings for a tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    scheduled_at  TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed')),
    notes         TEXT,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meetings_tenant ON meetings(tenant_id);

-- ---------------------------------------------------------------------------
-- seats: the Accountability Chart — a tree of roles/seats WITHIN one tenant.
-- parent_seat_id makes the Visionary -> Integrator -> ... hierarchy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seats (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    holder_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    parent_seat_id    UUID REFERENCES seats(id) ON DELETE CASCADE,
    responsibilities  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seats_tenant ON seats(tenant_id);
CREATE INDEX IF NOT EXISTS idx_seats_parent ON seats(parent_seat_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_meetings ON meetings;
CREATE POLICY tenant_isolation_meetings ON meetings
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE seats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_seats ON seats;
CREATE POLICY tenant_isolation_seats ON seats
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON meetings, seats TO hhcp_app;
