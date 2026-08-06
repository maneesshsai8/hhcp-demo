-- ============================================================================
-- Migration 32 — notification_deliveries: convert to MONTHLY native range
-- partitioning (partition key = created_at), automated by pg_partman + pg_cron,
-- with a BRIN index on the time column. This is the SAME "Plan A" pattern proven
-- for kpi_scores in migration 20 — see database/20_kpi_scores_partitioning.sql
-- and docs/POC-timeseries-storage.md.
--
-- WHY: notification_deliveries is the high-volume, append-only fan-out table
-- (one row per recipient x channel per announcement). A company-wide post to a
-- large tenant writes thousands of rows; over time this is the table that grows
-- without bound. Monthly partitions + BRIN keep it cheap to scan and let old
-- delivery telemetry be dropped by detaching a partition (instant) rather than a
-- row-by-row DELETE.
--
-- ⚠️ NOT a hot-path additive migration. It renames the existing table and copies
-- its rows into the partitioned one — a one-shot structural change. Run it ONCE,
-- in a maintenance window, verify row counts (step 7), then drop the legacy
-- table (step 8, left commented). The DO-block guards make re-runs safe (they
-- no-op once converted).
--
-- Prereqs: pg_partman + pg_cron (installed by migration 20; re-created here IF
-- NOT EXISTS so this migration is self-contained).
-- ============================================================================

-- 1. Extensions (idempotent) -------------------------------------------------
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Convert notification_deliveries -> partitioned parent (guarded, one-shot)
DO $$
DECLARE
    already_partitioned boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'notification_deliveries' AND n.nspname = 'public'
    ) INTO already_partitioned;

    IF already_partitioned THEN
        RAISE NOTICE 'notification_deliveries is already partitioned — skipping conversion.';
        RETURN;
    END IF;

    -- Move the existing plain table aside (only if it exists as an ordinary table).
    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'notification_deliveries' AND n.nspname = 'public' AND c.relkind = 'r'
    ) THEN
        ALTER TABLE public.notification_deliveries RENAME TO notification_deliveries_legacy;
        -- Free the canonical index/constraint names for the new table to reuse.
        ALTER INDEX IF EXISTS public.idx_ann_deliv_ann        RENAME TO idx_ann_deliv_ann_legacy;
        ALTER INDEX IF EXISTS public.idx_ann_deliv_status     RENAME TO idx_ann_deliv_status_legacy;
        ALTER INDEX IF EXISTS public.notification_deliveries_pkey RENAME TO notification_deliveries_pkey_legacy;
    END IF;

    -- Recreate as a RANGE-partitioned parent. created_at joins the PK so the
    -- "every unique key must contain the partition key" rule is satisfied; id
    -- stays effectively unique (gen_random_uuid). Shape mirrors migrations
    -- 23 + 31 exactly.
    CREATE TABLE public.notification_deliveries (
        id              UUID NOT NULL DEFAULT gen_random_uuid(),
        announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
        channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','push')),
        status          TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','sent','delivered','failed','bounced')),
        error           TEXT,
        sent_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- the partition key
        PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);

    -- Indexes on the parent cascade to every child partition.
    CREATE INDEX idx_ann_deliv_ann    ON public.notification_deliveries (announcement_id);
    CREATE INDEX idx_ann_deliv_status ON public.notification_deliveries (announcement_id, channel, status);
    -- BRIN on the time column: tiny and ideal for append-only, time-ordered data.
    CREATE INDEX idx_ann_deliv_created_brin
        ON public.notification_deliveries USING brin (created_at);

    -- Reproduce the tenant-isolation RLS from migration 23 verbatim.
    ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_notification_deliveries ON public.notification_deliveries
        FOR ALL
        USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
        WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)));
END $$;

-- 2b. Re-grant table privileges (a superuser-recreated table drops old grants).
--     Mirror whatever roles can use the sibling announcements table.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT grantee
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'announcements'
          AND grantee NOT IN (current_user, 'PUBLIC')
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_deliveries TO %I', r.grantee);
    END LOOP;
END $$;

-- 3. Register the parent with pg_partman (monthly range). Guarded.
SELECT partman.create_parent(
    p_parent_table  := 'public.notification_deliveries',
    p_control       := 'created_at',
    p_interval      := '1 month',
    p_type          := 'range',
    p_premake       := 4,
    p_default_table := true
)
WHERE NOT EXISTS (
    SELECT 1 FROM partman.part_config WHERE parent_table = 'public.notification_deliveries'
);

-- 4. Retention: keep 18 months of delivery telemetry, then drop old partitions.
--    (Read receipts / acknowledgments are compliance data and live in their own
--    tables with NO retention — this only trims the fan-out log.)
UPDATE partman.part_config
   SET retention = '18 months', retention_keep_table = false
 WHERE parent_table = 'public.notification_deliveries';

-- 5. Backfill from the legacy table (if present), then redistribute the DEFAULT
--    partition's rows into their correct monthly children.
DO $$
BEGIN
    IF to_regclass('public.notification_deliveries_legacy') IS NOT NULL THEN
        INSERT INTO public.notification_deliveries
            (id, announcement_id, tenant_id, user_id, channel, status, error, sent_at, created_at)
        SELECT id, announcement_id, tenant_id, user_id, channel,
               status, NULL, NULL, created_at
        FROM public.notification_deliveries_legacy
        ON CONFLICT DO NOTHING;   -- re-runnable
    END IF;
END $$;

CALL partman.partition_data_proc(p_parent_table := 'public.notification_deliveries');
ANALYZE public.notification_deliveries;

-- 6. Schedule pg_partman maintenance via pg_cron (premake future months, apply
--    retention). Daily at 03:15 UTC. Guarded against duplicate jobs.
SELECT cron.schedule(
    'notification_deliveries_partman_maintenance',
    '15 3 * * *',
    $$CALL partman.run_maintenance_proc();$$
)
WHERE NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'notification_deliveries_partman_maintenance'
);

-- 7. VERIFICATION (run manually before dropping legacy):
--   SELECT (SELECT count(*) FROM public.notification_deliveries)        AS new_count,
--          (SELECT count(*) FROM public.notification_deliveries_legacy) AS legacy_count;
--   SELECT inhrelid::regclass FROM pg_inherits
--     WHERE inhparent = 'public.notification_deliveries'::regclass ORDER BY 1;
--   SELECT count(*) FROM public.notification_deliveries_default;   -- expect 0 after step 5

-- 8. FINAL CLEANUP — only after step 7 passes (left commented on purpose):
--   DROP TABLE public.notification_deliveries_legacy;
