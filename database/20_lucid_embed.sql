-- ============================================================================
-- Migration 20 — Org Structure "link out" option: store a per-tenant Lucidchart
-- embed URL so the Accountability Chart can render a polished visual chart via
-- iframe (Approach 1, cookie-based — no API keys, no secrets on the frontend).
-- Additive & re-runnable.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lucid_embed_url TEXT;
