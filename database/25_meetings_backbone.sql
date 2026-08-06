-- ============================================================================
-- Migration 25 — Weekly Meetings production backbone:
--   * explicit state machine (widen status: +draft/paused/cancelled)
--   * server-authoritative pause/resume timer + persisted current segment
--   * optimistic-locking version columns (meeting + agenda aggregate)
--   * meeting_type
--   * transactional outbox (meeting_outbox)
--   * idempotency store (meeting_idempotency)
-- Additive & re-runnable. The outbox/idempotency tables are INFRASTRUCTURE
-- (like audit_log): NO row-level security — the background worker reads them
-- with no user context. Tenant data they touch is still guarded by RLS when
-- the worker sets app.current_user_id to the meeting's creator.
-- ============================================================================

-- ---- meetings: state machine + timer + optimistic lock -------------------
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_type               TEXT    NOT NULL DEFAULT 'level_10';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS version                    INT     NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS agenda_version             INT     NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS current_section_index      INT     NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS paused_at                  TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS accumulated_paused_seconds INT     NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now();

-- widen the status CHECK: scheduled/in_progress/completed -> + draft/paused/cancelled
DO $$
BEGIN
  ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
  ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
    CHECK (status IN ('draft','scheduled','in_progress','paused','completed','cancelled'));
  ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_meeting_type_check;
  ALTER TABLE meetings ADD CONSTRAINT meetings_meeting_type_check
    CHECK (meeting_type IN ('level_10','one_on_one','ad_hoc','custom'));
END $$;

-- ---- transactional outbox -------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    event_version   INT  NOT NULL DEFAULT 1,
    aggregate_type  TEXT NOT NULL DEFAULT 'meeting',
    aggregate_id    UUID NOT NULL,
    tenant_id       UUID,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED')),
    attempt_count   INT  NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the worker's hot path: claim due PENDING/FAILED rows in FIFO order
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON meeting_outbox(status, next_attempt_at)
    WHERE status IN ('PENDING','FAILED');
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON meeting_outbox(aggregate_id);

-- ---- idempotency store ----------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_idempotency (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID,
    user_id         UUID NOT NULL,
    command_name    TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash    TEXT,
    response_status INT,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    UNIQUE (user_id, command_name, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_idem_expires ON meeting_idempotency(expires_at);

-- ---- grants (mirror migration 24 pattern; these tables are RLS-free infra) ----
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_outbox      TO hhcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_idempotency TO hhcp_app;
