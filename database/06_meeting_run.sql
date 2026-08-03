-- ============================================================================
-- Migration 06 — turn Meetings into a runnable, agenda-driven L10 session.
-- Additive & re-runnable.
-- ============================================================================

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS agenda_key   TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS sections     JSONB;         -- snapshot of the agenda at start time
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ended_at     TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS rating       NUMERIC;       -- avg meeting rating 1-10
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
