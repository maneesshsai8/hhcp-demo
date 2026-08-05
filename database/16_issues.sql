-- ============================================================================
-- Migration 16 — Issues: owner assignment, resolution notes, category, VCB
-- linkage, and drag-to-rank ordering. Keeps the simple Open→Resolved model
-- (the DB value stays 'solved'; the UI labels it "Resolved"). Additive & re-runnable.
-- ============================================================================

ALTER TABLE issues ADD COLUMN IF NOT EXISTS owner_id        UUID REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS category        TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS vcb_id          UUID REFERENCES vcbs(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sort_order      INT NOT NULL DEFAULT 0;   -- drag-to-rank priority
ALTER TABLE issues ADD COLUMN IF NOT EXISTS archived        BOOLEAN NOT NULL DEFAULT false;

-- Seed a stable initial ranking (newest first) per tenant for open issues.
WITH ordered AS (
    SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at DESC) - 1 AS rn
    FROM issues
)
UPDATE issues i SET sort_order = o.rn FROM ordered o WHERE o.id = i.id AND i.sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_issues_owner ON issues(owner_id);
