-- ============================================================================
-- Migration 35 — Issue term: short-term vs long-term (ninety.io-style tabs).
-- Additive & re-runnable. Existing issues default to 'short'.
-- ============================================================================
ALTER TABLE issues ADD COLUMN IF NOT EXISTS term TEXT NOT NULL DEFAULT 'short'
    CHECK (term IN ('short', 'long'));
CREATE INDEX IF NOT EXISTS idx_issues_term ON issues(term);
