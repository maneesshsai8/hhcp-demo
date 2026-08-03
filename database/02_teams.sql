-- ============================================================================
-- Migration 02 — Teams, team membership, and team assignment on Rocks/Issues.
-- Additive: safe to run on the already-seeded demo database.
-- Mirrors "User & Team Management" from the Project Octane proposal.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- teams: a working group inside a single tenant (PortCo or Add-on)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id);

-- ---------------------------------------------------------------------------
-- team_members: which users belong to a team. tenant_id is carried on the
-- row too so the same tenant-isolation RLS policy applies uniformly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- ---------------------------------------------------------------------------
-- Rocks & Issues can now be assigned to a team
-- ---------------------------------------------------------------------------
ALTER TABLE rocks  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- RLS — same cascading tenant-isolation rule as every other feature table
-- ---------------------------------------------------------------------------
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_teams ON teams;
CREATE POLICY tenant_isolation_teams ON teams
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_team_members ON team_members;
CREATE POLICY tenant_isolation_team_members ON team_members
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

-- new tables need their own grant (the earlier ALL TABLES grant ran before they existed)
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO hhcp_app;
