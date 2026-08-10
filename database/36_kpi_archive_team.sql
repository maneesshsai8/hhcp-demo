-- 36_kpi_archive_team.sql
-- Measurable Manager parity with ninety.io:
--   * archived  — soft-archive a measurable (kept for history, hidden from the
--     active scorecard; shown in the Archived view). Replaces hard-delete for
--     the "Archive" bulk/row action.
--   * team_id   — associate a measurable with a team so the Scorecard/Manager
--     can show and filter measurables "based on the teams". Nullable: a
--     measurable with no team shows as "No team(s)".
-- Additive + re-runnable, same style as the other migrations.

ALTER TABLE kpis ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE kpis ADD COLUMN IF NOT EXISTS team_id  UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kpis_archived ON kpis(archived);
CREATE INDEX IF NOT EXISTS idx_kpis_team     ON kpis(team_id);
