-- ============================================================================
-- Migration 13 — To-Dos: priority, Issue linkage, source context, completion
-- notes, and weekly auto-carry-forward tracking. Additive & re-runnable.
-- (todos.vcb_id was already added in migration 12.)
-- ============================================================================

ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority        TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS issue_id        UUID REFERENCES issues(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'meeting', 'issue', 'scorecard'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS carried_count   INT NOT NULL DEFAULT 0;   -- weeks carried forward
ALTER TABLE todos ADD COLUMN IF NOT EXISTS last_carried_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS completion_note TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ;

-- CarryForwardLog data object: an audit row each time a weekly review rolls an
-- incomplete to-do into the next week.
CREATE TABLE IF NOT EXISTS carry_forward_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    todo_id     UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    carried_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id    UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_carry_todo ON carry_forward_log(todo_id);
CREATE INDEX IF NOT EXISTS idx_carry_tenant ON carry_forward_log(tenant_id);

-- carry_forward_log follows the same tenant isolation as its parent to-do.
ALTER TABLE carry_forward_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_carry ON carry_forward_log;
CREATE POLICY tenant_isolation_carry ON carry_forward_log
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON carry_forward_log TO hhcp_app;
