-- ============================================================================
-- Migration 19 — Supabase Auth linkage: add users.supabase_uid so app users can
-- be linked to their Supabase Auth identity. Additive & re-runnable.
-- ============================================================================

-- The Supabase Auth user id (JWT `sub`). NULL until the user's first Supabase
-- login links the row (see auth._ensure_app_user). UNIQUE so one Supabase
-- identity maps to at most one app user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_uid UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_supabase_uid ON users(supabase_uid);
