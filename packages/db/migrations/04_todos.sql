-- ============================================================================
-- Migration 04 — To-Dos module + richer fields on Rocks/Issues to support the
-- Ninety-style "Create" modals (description, priority). Additive, re-runnable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- todos: assignable tasks with deadlines (Ninety "To-Dos")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todos (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    due_date     DATE,
    owner_id     UUID REFERENCES users(id),
    team_id      UUID REFERENCES teams(id) ON DELETE SET NULL,
    is_private   BOOLEAN NOT NULL DEFAULT false,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_tenant ON todos(tenant_id);

-- richer fields for the create modals
ALTER TABLE rocks  ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS priority TEXT;   -- 'low' | 'medium' | 'high' | NULL

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_todos ON todos;
CREATE POLICY tenant_isolation_todos ON todos
    FOR ALL
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO hhcp_app;
