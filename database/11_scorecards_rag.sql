-- ============================================================================
-- Migration 11 — Scorecards: RAG (Red/Yellow/Green) thresholds, direction-aware
-- status, KPI description/frequency, and drag-to-reorder ordering.
-- Additive & re-runnable. Time-series (kpi_scores) is untouched — history stays
-- immutable, so editing a goal or threshold never rewrites past RAG history.
-- ============================================================================

ALTER TABLE kpis ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS frequency        TEXT NOT NULL DEFAULT 'weekly'
    CHECK (frequency IN ('weekly', 'monthly'));
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS direction        TEXT NOT NULL DEFAULT 'higher_is_better'
    CHECK (direction IN ('higher_is_better', 'lower_is_better'));

-- The yellow band lives between green_threshold (meets goal) and red_threshold.
--   higher_is_better:  actual >= green -> GREEN, actual < red -> RED, else YELLOW
--   lower_is_better :  actual <= green -> GREEN, actual > red -> RED, else YELLOW
-- When green == red there is no yellow band (legacy binary GREEN/RED behaviour).
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS green_threshold  NUMERIC;
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS red_threshold    NUMERIC;
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS sort_order       INT NOT NULL DEFAULT 0;

-- Backfill existing KPIs: derive direction from the old operator, seed the
-- thresholds off the goal so nothing changes colour until an admin sets a band.
UPDATE kpis SET direction = CASE WHEN comparison_operator = '<=' THEN 'lower_is_better'
                                 ELSE 'higher_is_better' END
WHERE direction = 'higher_is_better' AND comparison_operator = '<=';

UPDATE kpis SET green_threshold = target_value WHERE green_threshold IS NULL;
UPDATE kpis SET red_threshold   = target_value WHERE red_threshold   IS NULL;

-- Stable initial ordering by creation time.
WITH ordered AS (
    SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, title) - 1 AS rn
    FROM kpis
)
UPDATE kpis k SET sort_order = o.rn FROM ordered o WHERE o.id = k.id AND k.sort_order = 0;
