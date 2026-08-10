-- ============================================================================
-- Migration 22 — Vision: a single static per-tenant page (Mission / Vision /
-- Core Values). Leadership edits, everyone in the tenant reads. Additive & re-runnable.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vision_documents (
    tenant_id    UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    mission      TEXT,
    vision       TEXT,
    core_values  TEXT,
    updated_by   UUID REFERENCES users(id),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE vision_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_vision ON vision_documents;
CREATE POLICY tenant_isolation_vision ON vision_documents
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));
GRANT SELECT, INSERT, UPDATE, DELETE ON vision_documents TO hhcp_app;
