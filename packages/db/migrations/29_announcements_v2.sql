-- ============================================================================
-- Migration 29 — Announcements v2: lifecycle status + scheduling, rich-text
-- format, priority, and a real full-text search index for the archive.
-- Additive & re-runnable (guarded ALTERs / IF NOT EXISTS everywhere).
--
-- Rationale (docs/ANNOUNCEMENTS-ARCHITECTURE.md §1 C/D/G): the first cut stored
-- plain TEXT and searched with `title ILIKE '%q%'` (un-indexable full scan) and
-- had no publish/scheduling seam. This migration adds:
--   • status (scheduled|published|archived) + publish_at  → future-dated posts
--   • body_format + priority                              → rich text + banner
--   • search_tsv (STORED generated tsvector) + GIN        → searchable archive
--   • title trigram index                                 → fuzzy title match
-- ============================================================================

-- pg_trgm powers fuzzy/substring title matching; available on stock Postgres
-- and on Supabase. GIN full-text uses the built-in tsvector machinery.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---- new columns (all additive; existing rows default to a published post) --
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'published';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS publish_at  TIMESTAMPTZ;      -- set when status='scheduled'
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'html';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS priority    TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- CHECK constraints, drop-then-add so re-runs (and value-set changes) are safe.
DO $$
BEGIN
  ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_status_check;
  ALTER TABLE announcements ADD  CONSTRAINT announcements_status_check
    CHECK (status IN ('scheduled','published','archived'));
  ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_body_format_check;
  ALTER TABLE announcements ADD  CONSTRAINT announcements_body_format_check
    CHECK (body_format IN ('html','markdown','plain'));
  ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_priority_check;
  ALTER TABLE announcements ADD  CONSTRAINT announcements_priority_check
    CHECK (priority IN ('normal','high'));
END $$;

-- ---- full-text search vector (STORED generated column) ----------------------
-- Title weighted A, body weighted B, so a title hit ranks above a body hit.
-- immutable-safe: to_tsvector('english', ...) is immutable, required for STORED.
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_ann_search     ON announcements USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_ann_title_trgm ON announcements USING gin (title gin_trgm_ops);

-- Feed hot path: published posts, pinned first then newest, within a tenant.
CREATE INDEX IF NOT EXISTS idx_ann_feed
  ON announcements (tenant_id, pinned DESC, created_at DESC)
  WHERE status = 'published';

-- Scheduler hot path: the pg_cron job (migration 33) claims due scheduled posts.
CREATE INDEX IF NOT EXISTS idx_ann_due
  ON announcements (publish_at)
  WHERE status = 'scheduled';
