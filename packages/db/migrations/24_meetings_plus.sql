-- ============================================================================
-- Migration 24 — Weekly Meetings gaps: persisted attendance, auto post-meeting
-- summary, and custom agenda templates. Additive & re-runnable.
-- ============================================================================
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary JSONB;   -- auto-generated on finish

CREATE TABLE IF NOT EXISTS meeting_attendance (
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    present    BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS agenda_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sections   JSONB NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agenda_templates_tenant ON agenda_templates(tenant_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_attendance','agenda_templates']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format($p$CREATE POLICY tenant_isolation_%I ON %I
        USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
        WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))$p$, t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hhcp_app', t);
  END LOOP;
END $$;
