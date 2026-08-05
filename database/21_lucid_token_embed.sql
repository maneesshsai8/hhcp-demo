-- ============================================================================
-- Migration 21 — Lucidchart Approach 2 (token-based embeds). Per-tenant embed
-- document id; the app mints a short-lived session token server-side each view
-- so viewers never need a Lucid account or a login prompt. Additive & re-runnable.
-- ============================================================================
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lucid_embed_id TEXT;
