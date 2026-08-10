-- ============================================================================
-- Migration 28 — Calendar provider links.
--   External calendar sync is ASYNC and best-effort: the internal meeting is
--   always authoritative. If a provider call fails, the meeting stands and the
--   link row records the failure for the worker to retry. Additive & re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS meeting_calendar_links (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id           UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    tenant_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider             TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
    external_event_id    TEXT,
    external_calendar_id TEXT,
    sync_status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK (sync_status IN ('pending','synced','failed','not_configured','cancelled')),
    last_synced_at       TIMESTAMPTZ,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (meeting_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_cal_links_meeting  ON meeting_calendar_links(meeting_id);
CREATE INDEX IF NOT EXISTS idx_cal_links_external ON meeting_calendar_links(external_event_id);

ALTER TABLE meeting_calendar_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_meeting_calendar_links ON meeting_calendar_links;
CREATE POLICY tenant_isolation_meeting_calendar_links ON meeting_calendar_links
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_calendar_links TO hhcp_app;
