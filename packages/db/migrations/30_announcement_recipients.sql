-- ============================================================================
-- Migration 30 — announcement_recipients: the explicit audience snapshot.
-- Additive & re-runnable.
--
-- Rationale (docs/ANNOUNCEMENTS-ARCHITECTURE.md §3.2 / §4): the first cut derived
-- the ack% denominator from notification_deliveries rows, an *accidental* frozen
-- snapshot. This table makes the snapshot explicit and is the single source of
-- truth for (a) the ack tracker denominator and (b) who deliveries fan out to.
-- It is written by the outbox worker when it processes `announcement.published`
-- (a set-based INSERT ... SELECT over the audience), NOT in the request path.
-- ============================================================================
CREATE TABLE IF NOT EXISTS announcement_recipients (
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ann_recipients_ann ON announcement_recipients(announcement_id);

-- Same tenant-isolation RLS + app-role grant as the other announcement tables
-- (migration 23). The worker reads/writes it under the author's user context
-- (app.current_user_id), so RLS passes without any superuser bypass.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE announcement_recipients ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_announcement_recipients ON announcement_recipients';
  EXECUTE $p$CREATE POLICY tenant_isolation_announcement_recipients ON announcement_recipients
      USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))$p$;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON announcement_recipients TO hhcp_app';
END $$;
