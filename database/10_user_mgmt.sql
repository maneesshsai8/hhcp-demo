-- ============================================================================
-- Migration 10 — User & Team Management: directory custom fields, active/inactive
-- status, and an admin audit log. Additive & re-runnable.
-- ============================================================================

-- directory custom fields + active status
ALTER TABLE users ADD COLUMN IF NOT EXISTS title       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT true;

-- audit log: every login, edit, deactivation, grant, etc. Admin-viewed via the
-- app (no RLS — it deliberately spans tenants for compliance review).
CREATE TABLE IF NOT EXISTS audit_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name   TEXT,                 -- denormalized so the log survives user deletion
    action       TEXT NOT NULL,        -- 'login' | 'user.create' | 'user.deactivate' | 'grant' | ...
    entity_type  TEXT,                 -- 'user' | 'organization' | 'tenant_membership' | ...
    entity_id    UUID,
    tenant_id    UUID,
    detail       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

GRANT SELECT, INSERT ON audit_log TO hhcp_app;
