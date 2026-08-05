-- ============================================================================
-- Migration 12 — VCBs (Value Creation Blueprints) & Workstreams
-- HHCP's strategic layer ABOVE standard EOS Rocks. A VCB is a 12–36 month
-- initiative aligned to an investment thesis; it holds named workstreams;
-- Rocks ladder up to a workstream for roll-up reporting. Additive & re-runnable.
-- ============================================================================

-- 1. VCBs — one per strategic initiative, tenant-scoped.
CREATE TABLE IF NOT EXISTS vcbs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    description        TEXT,
    investment_thesis  TEXT,          -- e.g. 'Margin expansion', 'Geographic expansion', 'Tuck-in M&A'
    outcome            TEXT,          -- measurable outcome / target for the blueprint
    start_date         DATE,
    end_date           DATE,          -- 12–36 months out
    status             TEXT NOT NULL DEFAULT 'on_track'
                       CHECK (status IN ('on_track', 'off_track', 'complete')),
    archived           BOOLEAN NOT NULL DEFAULT false,   -- completed VCBs are archived w/ history
    created_by         UUID REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vcbs_tenant ON vcbs(tenant_id);

-- 2. Workstreams — named lanes inside a VCB. tenant_id denormalized for RLS.
CREATE TABLE IF NOT EXISTS workstreams (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vcb_id       UUID NOT NULL REFERENCES vcbs(id) ON DELETE CASCADE,
    tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workstreams_vcb ON workstreams(vcb_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_tenant ON workstreams(tenant_id);

-- 3. Parent/child linkage: Rocks -> Workstream (the roll-up spine).
ALTER TABLE rocks ADD COLUMN IF NOT EXISTS workstream_id UUID REFERENCES workstreams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_rocks_workstream ON rocks(workstream_id);

-- 4. Direct VCB links from To-Dos and Scorecards (KPIs).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS vcb_id UUID REFERENCES vcbs(id) ON DELETE SET NULL;
ALTER TABLE kpis  ADD COLUMN IF NOT EXISTS vcb_id UUID REFERENCES vcbs(id) ON DELETE SET NULL;

-- 5. RLS — same tenant-isolation pattern as issues (no per-user scoping: VCBs are
--    a leadership/strategy layer, visible to everyone who can see the tenant).
ALTER TABLE vcbs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_vcbs ON vcbs;
CREATE POLICY tenant_isolation_vcbs ON vcbs
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE workstreams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_workstreams ON workstreams;
CREATE POLICY tenant_isolation_workstreams ON workstreams
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON vcbs TO hhcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workstreams TO hhcp_app;
