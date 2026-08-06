-- ============================================================================
-- Migration 20 — Scorecards time-series: convert kpi_scores to MONTHLY native
-- range partitioning, automated by pg_partman + pg_cron, with a BRIN index on
-- the time column. This is "Plan A" from docs/POC-timeseries-storage.md — the
-- Supabase-native substitute for TimescaleDB (which is NOT available on this
-- project; verified 2026-08-05, see the POC doc §2).
--
-- IMMUTABILITY IS PRESERVED: the table stays append-only, the primary key is
-- unchanged (kpi_id, recorded_at), RLS is reproduced identically, and NO
-- application query in backend/app/routers/scorecards.py needs to change —
-- partitioning is transparent to `SELECT ... FROM kpi_scores`.
--
-- ⚠️ NOT a hot-path additive migration. The conversion renames the existing
-- table and copies its rows into the partitioned one — a one-shot structural
-- change. Run it ONCE, in a maintenance window, and verify row counts (step 7)
-- BEFORE dropping the legacy table (step 8, left commented on purpose).
-- The DO-block guards make re-runs safe (they no-op once converted).
--
-- Supabase prerequisites (enable once, via Dashboard → Database → Extensions):
--   • pg_cron     — already installed on this project (verified).
--   • pg_partman  — AVAILABLE but not yet installed; step 1 creates it.
-- pg_partman's background worker is NOT available on Supabase, so maintenance
-- is driven by pg_cron calling partman.run_maintenance_proc() (step 6).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
-- pg_cron is expected to already exist (Supabase installs it in schema `cron`).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 2. Convert kpi_scores → partitioned parent (guarded, one-shot)
--    Postgres cannot ALTER a plain table into a partitioned one in place, so
--    we rename the existing table aside and recreate it partitioned. The new
--    table is byte-for-byte the same shape as database/01_schema.sql.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    already_partitioned boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'kpi_scores' AND n.nspname = 'public'
    ) INTO already_partitioned;

    IF already_partitioned THEN
        RAISE NOTICE 'kpi_scores is already partitioned — skipping conversion.';
        RETURN;
    END IF;

    -- Move the existing plain table aside (only if it exists as an ordinary table).
    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'kpi_scores' AND n.nspname = 'public' AND c.relkind = 'r'
    ) THEN
        ALTER TABLE public.kpi_scores RENAME TO kpi_scores_legacy;
        -- Renaming a table does NOT rename its indexes, and index names are
        -- schema-scoped — so free the canonical names for the new table to reuse.
        ALTER INDEX IF EXISTS public.idx_kpi_scores_tenant RENAME TO idx_kpi_scores_tenant_legacy;
        ALTER INDEX IF EXISTS public.kpi_scores_pkey        RENAME TO kpi_scores_pkey_legacy;
    END IF;

    -- Recreate as a RANGE-partitioned parent. The partition key (recorded_at)
    -- is part of the PK, satisfying Postgres's "every unique key must contain
    -- the partition key" rule — the current PK (kpi_id, recorded_at) already
    -- did, so nothing about identity or the append-only contract changes.
    CREATE TABLE public.kpi_scores (
        tenant_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        kpi_id        UUID NOT NULL REFERENCES kpis(id) ON DELETE CASCADE,
        recorded_at   TIMESTAMPTZ NOT NULL,   -- week-ending timestamp; the partition key
        actual_value  NUMERIC NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kpi_id, recorded_at)
    ) PARTITION BY RANGE (recorded_at);

    -- Indexes defined on the parent cascade to every child partition.
    -- Keep the tenant btree (RLS filters by tenant_id) ...
    CREATE INDEX idx_kpi_scores_tenant ON public.kpi_scores (tenant_id);
    -- ... and add a BRIN on the time column: tiny (KBs) and ideal for
    -- append-only, physically time-ordered data — the one storage win that
    -- echoes TimescaleDB, using only core Postgres.
    CREATE INDEX idx_kpi_scores_recorded_brin ON public.kpi_scores USING brin (recorded_at);

    -- Reproduce the RLS policy verbatim from 01_schema.sql (tenant isolation
    -- via the same user_accessible_tenants() tree-walk). Policies do NOT
    -- inherit automatically to a partitioned parent's children in older PG,
    -- but on a partitioned PARENT the policy applies to all partitions in
    -- PG11+; enabling here is sufficient.
    ALTER TABLE public.kpi_scores ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_kpi_scores ON public.kpi_scores
        FOR ALL
        USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
        WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));
END $$;

-- ---------------------------------------------------------------------------
-- 2b. Re-grant table privileges to the application role(s).
--     A table recreated by the superuser does NOT inherit the old table's
--     grants, so the app role would hit "permission denied" (RLS is a second
--     gate AFTER the GRANT check). Rather than hard-code a role name, mirror
--     whatever roles can use the sibling `kpis` table — portable across
--     environments (local `hhcp_app`, Supabase's roles, etc.). Grants on the
--     partitioned parent are sufficient; DML routed through the parent is
--     checked against the parent, and pg_partman-created children inherit.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT grantee
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'kpis'
          AND grantee NOT IN (current_user, 'PUBLIC')
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpi_scores TO %I', r.grantee);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Register the parent with pg_partman (monthly range).
--    Guarded: only runs if not already registered.
--    NOTE (verify against pg_partman 5.3.1 — it wasn't installed at authoring
--    time so the signature couldn't be introspected): 5.x create_parent uses
--    p_type := 'range' for native declarative partitioning and takes the
--    interval as a text value. p_default_table := true creates a DEFAULT
--    partition so back-dated rows never fail to route (step 5 redistributes).
-- ---------------------------------------------------------------------------
SELECT partman.create_parent(
    p_parent_table := 'public.kpi_scores',
    p_control      := 'recorded_at',
    p_interval     := '1 month',
    p_type         := 'range',
    p_premake      := 4,
    p_default_table := true
)
WHERE NOT EXISTS (
    SELECT 1 FROM partman.part_config WHERE parent_table = 'public.kpi_scores'
);

-- ---------------------------------------------------------------------------
-- 4. Retention: DISABLED on purpose.
--    Scorecard KPI history is immutable and kept forever, so we do NOT set a
--    retention interval. To enable (e.g. keep 10 years) in the future:
--      UPDATE partman.part_config
--         SET retention = '10 years', retention_keep_table = true
--       WHERE parent_table = 'public.kpi_scores';
--    Dropping an old monthly partition is then instant vs a row-by-row DELETE.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Backfill existing rows from the legacy table (only if it exists), then
--    redistribute anything that landed in the DEFAULT partition into the
--    correct monthly child partitions.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.kpi_scores_legacy') IS NOT NULL THEN
        INSERT INTO public.kpi_scores (tenant_id, kpi_id, recorded_at, actual_value, created_at)
        SELECT tenant_id, kpi_id, recorded_at, actual_value, created_at
        FROM public.kpi_scores_legacy
        ON CONFLICT (kpi_id, recorded_at) DO NOTHING;   -- keeps this step re-runnable
    END IF;
END $$;

-- Move rows out of the DEFAULT partition into monthly children (creates the
-- historical child partitions on demand). Safe no-op if nothing is in default.
CALL partman.partition_data_proc(p_parent_table := 'public.kpi_scores');
ANALYZE public.kpi_scores;

-- ---------------------------------------------------------------------------
-- 6. Schedule pg_partman maintenance via pg_cron (premakes future months,
--    applies retention if ever enabled). Daily at 03:00 UTC. Guarded so a
--    re-run doesn't create a duplicate job.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
    'kpi_scores_partman_maintenance',
    '0 3 * * *',
    $$CALL partman.run_maintenance_proc();$$
)
WHERE NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'kpi_scores_partman_maintenance'
);

-- ---------------------------------------------------------------------------
-- 7. VERIFICATION (run manually, do not automate) — confirm the conversion
--    before dropping the legacy table:
--
--   -- row counts must match
--   SELECT (SELECT count(*) FROM public.kpi_scores)        AS new_count,
--          (SELECT count(*) FROM public.kpi_scores_legacy) AS legacy_count;
--
--   -- parent is partitioned and children exist
--   SELECT inhrelid::regclass AS partition
--     FROM pg_inherits WHERE inhparent = 'public.kpi_scores'::regclass
--    ORDER BY 1;
--
--   -- DEFAULT partition should be empty after step 5
--   SELECT count(*) FROM public.kpi_scores_default;
--
--   -- partition pruning works: this should scan only the relevant month(s)
--   EXPLAIN SELECT recorded_at, actual_value FROM public.kpi_scores
--    WHERE kpi_id = '00000000-0000-0000-0000-000000000000'
--      AND recorded_at >= now() - interval '90 days'
--    ORDER BY recorded_at DESC LIMIT 13;
--
--   -- RLS still isolates tenants (expect 0 rows with no context set)
--   SELECT count(*) FROM public.kpi_scores;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8. FINAL CLEANUP — run ONLY after step 7 verification passes. Left commented
--    so the legacy data is never dropped automatically.
--
--   DROP TABLE public.kpi_scores_legacy;
-- ---------------------------------------------------------------------------
