-- ============================================================================
-- Migration 26 — Normalize the meeting agenda into per-item rows.
--   Until now the agenda lived as a JSONB snapshot in meetings.sections. That
--   stays (dual-written) so the current runner keeps working, but the source of
--   truth for per-segment TIMER state + per-item optimistic locking is now a
--   real table. Each item carries its own status/timer, matching the meeting-
--   level state machine from migration 25.
-- tenant_id is denormalized onto the row (like meeting_attendance) so the
-- standard tenant-isolation RLS policy applies directly.
-- Additive & re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS meeting_agenda_items (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id                 UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    tenant_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    segment_type               TEXT NOT NULL DEFAULT 'text',   -- segue/scorecard/rocks/vcbs/todos/issues/text/conclude
    title                      TEXT NOT NULL,
    description                TEXT,
    duration_seconds           INT  NOT NULL DEFAULT 300,
    display_order              INT  NOT NULL DEFAULT 0,
    status                     TEXT NOT NULL DEFAULT 'PENDING'
                                  CHECK (status IN ('PENDING','IN_PROGRESS','PAUSED','COMPLETED','SKIPPED')),
    started_at                 TIMESTAMPTZ,
    paused_at                  TIMESTAMPTZ,
    completed_at               TIMESTAMPTZ,
    accumulated_paused_seconds INT  NOT NULL DEFAULT 0,
    notes                      TEXT,
    config                     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- can_create_issues, loads_module_data, etc.
    version                    INT  NOT NULL DEFAULT 1,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agenda_items_meeting ON meeting_agenda_items(meeting_id, display_order);
CREATE INDEX IF NOT EXISTS idx_agenda_items_tenant  ON meeting_agenda_items(tenant_id);

-- one display_order per meeting (deferrable so a reorder can shuffle within one txn)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_agenda_item_order') THEN
    ALTER TABLE meeting_agenda_items
      ADD CONSTRAINT uq_agenda_item_order UNIQUE (meeting_id, display_order) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- RLS (same cascading tenant-isolation pattern as every other tenant table)
ALTER TABLE meeting_agenda_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_meeting_agenda_items ON meeting_agenda_items;
CREATE POLICY tenant_isolation_meeting_agenda_items ON meeting_agenda_items
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_agenda_items TO hhcp_app;
