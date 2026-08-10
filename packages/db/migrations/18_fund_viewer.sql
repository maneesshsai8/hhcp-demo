-- ============================================================================
-- Migration 18 — Fund Viewer role. A read-only counterpart to the fund admin:
-- can open the fund-level provisioning dashboard and see every PortCo, grant,
-- and membership, but cannot create/edit/grant/revoke anything.
-- Additive & re-runnable.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_fund_viewer BOOLEAN NOT NULL DEFAULT false;
