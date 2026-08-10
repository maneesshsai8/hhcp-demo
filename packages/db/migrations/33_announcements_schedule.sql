-- ============================================================================
-- Migration 33 — scheduled / future-dated announcements via pg_cron.
-- Additive & re-runnable.
--
-- A post created with status='scheduled' and a future publish_at is invisible in
-- the feed until due. This job flips due rows to 'published' and emits ONE
-- `announcement.published` event per post into the transactional outbox — the
-- SAME event an immediate publish emits — so the outbox worker's fan-out path is
-- identical whether a post went out now or was scheduled (docs §5).
--
-- The emit mirrors backend/app/outbox.py::emit() column-for-column. actorId is
-- the author (author_id): the worker sets app.current_user_id to it so its
-- recipient/delivery writes pass RLS, exactly as the meetings events do.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- SECURITY DEFINER so the cron job (which has no per-request user context) can
-- see and flip scheduled posts across all tenants. announcements has RLS ENABLEd
-- but not FORCEd, so the definer (table owner) bypasses it — correct for a
-- system scheduler. meeting_outbox is RLS-free infra.
CREATE OR REPLACE FUNCTION publish_due_announcements()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    n integer := 0;
    rec RECORD;
BEGIN
    FOR rec IN
        UPDATE announcements
           SET status = 'published', updated_at = now()
         WHERE status = 'scheduled'
           AND publish_at IS NOT NULL
           AND publish_at <= now()
        RETURNING id, tenant_id, author_id
    LOOP
        INSERT INTO meeting_outbox
            (event_type, event_version, aggregate_type, aggregate_id, tenant_id, payload)
        VALUES (
            'announcement.published', 1, 'announcement', rec.id, rec.tenant_id,
            jsonb_build_object(
                'announcementId', rec.id,
                'tenantId',       rec.tenant_id,
                'actorId',        rec.author_id
            )
        );
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

-- Run every minute. Guarded against duplicate jobs on re-run.
SELECT cron.schedule(
    'announcements_publish_due',
    '* * * * *',
    $$SELECT publish_due_announcements();$$
)
WHERE NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'announcements_publish_due'
);
