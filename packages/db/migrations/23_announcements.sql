-- ============================================================================
-- Migration 23 — Announcements (Headlines): company/team posts with read
-- receipts, acknowledgments, comments, reactions, and delivery records.
-- Additive & re-runnable.
-- ============================================================================
CREATE TABLE IF NOT EXISTS announcements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    author_id    UUID REFERENCES users(id),
    title        TEXT NOT NULL,
    body         TEXT,
    category     TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('win','news','update','general')),
    audience     TEXT NOT NULL DEFAULT 'tenant'  CHECK (audience IN ('tenant','team')),
    team_id      UUID REFERENCES teams(id) ON DELETE CASCADE,
    pinned       BOOLEAN NOT NULL DEFAULT false,
    requires_ack BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ann_tenant ON announcements(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_receipts (
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ,
    ack_at          TIMESTAMPTZ,
    PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ann_receipts_ann ON announcement_receipts(announcement_id);

CREATE TABLE IF NOT EXISTS announcement_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id),
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ann_comments_ann ON announcement_comments(announcement_id, created_at);

CREATE TABLE IF NOT EXISTS announcement_reactions (
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    emoji           TEXT NOT NULL,
    PRIMARY KEY (announcement_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','push')),
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ann_deliv_ann ON notification_deliveries(announcement_id);

-- Uniform tenant-isolation RLS on all five.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['announcements','announcement_receipts','announcement_comments','announcement_reactions','notification_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I', t, t);
    EXECUTE format($p$CREATE POLICY tenant_isolation_%I ON %I
        USING (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))
        WITH CHECK (tenant_id IN (SELECT tenant_id FROM user_accessible_tenants(current_setting('app.current_user_id', true)::uuid)))$p$, t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hhcp_app', t);
  END LOOP;
END $$;
