-- ============================================================================
-- Migration 27 — Per-user meeting ratings.
--   Replaces the single meetings.rating scalar with one rating per attendee.
--   meetings.rating is kept as a CACHED average (recomputed on each submit) so
--   the existing trend endpoint, summary builder, and history table keep working
--   with no change.
-- Additive & re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS meeting_ratings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    rating        NUMERIC NOT NULL CHECK (rating >= 1 AND rating <= 10),
    feedback      TEXT,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (meeting_id, user_id)          -- one rating per user per meeting
);
CREATE INDEX IF NOT EXISTS idx_meeting_ratings_meeting ON meeting_ratings(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_ratings_tenant  ON meeting_ratings(tenant_id);

ALTER TABLE meeting_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_meeting_ratings ON meeting_ratings;
CREATE POLICY tenant_isolation_meeting_ratings ON meeting_ratings
    USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
    WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_ratings TO hhcp_app;
