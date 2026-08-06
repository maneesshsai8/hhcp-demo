-- ============================================================================
-- Migration 31 — notification_deliveries: delivery lifecycle columns.
-- Additive & re-runnable. Kept SEPARATE from the partition conversion
-- (migration 32) on purpose: these columns are safe to apply anytime, while the
-- partition conversion is a run-once-in-a-window structural change.
--
-- The worker (outbox_worker) inserts one row per (recipient x channel) as
-- 'queued', then updates status as each channel is dispatched. A per-recipient
-- failure records here and does NOT fail the whole announcement event.
-- ============================================================================
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS error   TEXT;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Existing rows were inserted as 'sent' (the old default). Widen the vocabulary
-- and flip the default to 'queued' for the new worker-driven inserts.
ALTER TABLE notification_deliveries ALTER COLUMN status SET DEFAULT 'queued';

DO $$
BEGIN
  ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;
  ALTER TABLE notification_deliveries ADD  CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('queued','sent','delivered','failed','bounced'));
END $$;

-- Admin delivery report lookups by announcement + channel + status.
CREATE INDEX IF NOT EXISTS idx_ann_deliv_status
  ON notification_deliveries(announcement_id, channel, status);
