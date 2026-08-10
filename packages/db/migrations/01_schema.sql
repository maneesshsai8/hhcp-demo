-- ============================================================================
-- HHCP Demo — Core Schema
-- Implements: Fund -> PortCo -> Add-on hierarchy, tiered RLS (Option B: 
-- database-driven authorization, re-checked every request via a function,
-- not baked into JWT claims).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. organizations: the tenant tree itself (Fund / PortCo / Add-on)
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    tenant_type         TEXT NOT NULL CHECK (tenant_type IN ('fund', 'portco', 'addon')),
    parent_tenant_id    UUID REFERENCES organizations(id) ON DELETE SET NULL,
    fund_label          TEXT,               -- e.g. 'Fund II', 'Continuation Vehicle'
    acquisition_date    DATE,
    transaction_type    TEXT,               -- 'buyout', 'carveout', 'merger', etc.
    exit_date           DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_organizations_parent ON organizations(parent_tenant_id);

-- ---------------------------------------------------------------------------
-- 2. users: just people, deliberately with no tenant column at all
-- ---------------------------------------------------------------------------
-- is_fund_admin: Tier 1 — Hidden Harbor's own staff, above every tenant. A
-- user has at most one fund-level role and it's only ever "admin", so it's a
-- flag here rather than its own table.
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    is_fund_admin   BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. tenant_memberships: Tier 2 — the actual grant list (who can see what)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('lead_partner', 'deal_qb', 'ops_qb', 'portco_management', 'addon_management', 'deal_team', 'pog_member')),
    granted_by  UUID REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, tenant_id)
);
CREATE INDEX idx_tenant_memberships_user ON tenant_memberships(user_id);
CREATE INDEX idx_tenant_memberships_tenant ON tenant_memberships(tenant_id);

-- ---------------------------------------------------------------------------
-- 5. refresh_tokens: server-side session tracking, so access can be revoked
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================================
-- FEATURE TABLES (the 3 EOS modules we're proving the architecture against)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 6. kpis + kpi_scores: Scorecards (time-series, append-only history)
-- ---------------------------------------------------------------------------
CREATE TABLE kpis (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title                TEXT NOT NULL,
    owner_id             UUID REFERENCES users(id),
    target_value         NUMERIC NOT NULL,
    comparison_operator  TEXT NOT NULL DEFAULT '>=' CHECK (comparison_operator IN ('>=', '<=', '=')),
    unit                 TEXT DEFAULT 'units',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kpis_tenant ON kpis(tenant_id);

CREATE TABLE kpi_scores (
    tenant_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kpi_id        UUID NOT NULL REFERENCES kpis(id) ON DELETE CASCADE,
    recorded_at   TIMESTAMPTZ NOT NULL,   -- week-ending timestamp
    actual_value  NUMERIC NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kpi_id, recorded_at)
);
CREATE INDEX idx_kpi_scores_tenant ON kpi_scores(tenant_id);

-- ---------------------------------------------------------------------------
-- 7. rocks: annual priorities
-- ---------------------------------------------------------------------------
CREATE TABLE rocks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    owner_id    UUID REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track', 'off_track', 'complete')),
    due_date    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rocks_tenant ON rocks(tenant_id);

-- ---------------------------------------------------------------------------
-- 8. issues: the running issues list
-- ---------------------------------------------------------------------------
CREATE TABLE issues (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'solved')),
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    solved_at    TIMESTAMPTZ
);
CREATE INDEX idx_issues_tenant ON issues(tenant_id);

-- ============================================================================
-- THE CORE AUTHORIZATION FUNCTION (Option B — database-driven, live-checked)
-- ============================================================================
-- Given a user, returns every tenant_id they're currently allowed to see:
--   - Fund-level staff (users.is_fund_admin) see EVERY tenant (Tier 1 rollup)
--   - Everyone else sees exactly the tenants they've been granted (Tier 2),
--     PLUS every descendant underneath those tenants (cascading access)
-- This is re-evaluated on every single query. Revoke a grant, and the very
-- next request stops seeing that tenant's data — no stale JWT claim involved.
-- ============================================================================
CREATE OR REPLACE FUNCTION user_accessible_tenants(p_user_id UUID)
RETURNS TABLE(tenant_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RETURN;
    END IF;

    -- Tier 1: fund-level staff see the entire portfolio (read/rollup access)
    IF (SELECT u.is_fund_admin FROM users u WHERE u.id = p_user_id) THEN
        RETURN QUERY SELECT o.id FROM organizations o;
        RETURN;
    END IF;

    -- Tier 2+: explicit grants, cascaded down to every descendant tenant
    RETURN QUERY
    WITH RECURSIVE granted AS (
        SELECT tm.tenant_id AS id
        FROM tenant_memberships tm
        WHERE tm.user_id = p_user_id
    ),
    tree AS (
        SELECT id FROM granted
        UNION ALL
        SELECT o.id
        FROM organizations o
        JOIN tree t ON o.parent_tenant_id = t.id
    )
    SELECT DISTINCT id FROM tree;
END;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_organizations ON organizations
    FOR ALL
    USING (id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (true);  -- provisioning inserts checked at the application layer

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_memberships ON tenant_memberships
    FOR ALL
    USING (
        user_id = current_setting('app.current_user_id', true)::uuid
        OR (SELECT u.is_fund_admin FROM users u WHERE u.id = current_setting('app.current_user_id', true)::uuid)
    );

ALTER TABLE kpis ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_kpis ON kpis
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE kpi_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_kpi_scores ON kpi_scores
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE rocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_rocks ON rocks
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_issues ON issues
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

-- ============================================================================
-- GRANTS — hhcp_app is a normal (non-owner, non-superuser) role, so every
-- policy above is enforced automatically for anything it does.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hhcp_app;
GRANT EXECUTE ON FUNCTION user_accessible_tenants(UUID) TO hhcp_app;
