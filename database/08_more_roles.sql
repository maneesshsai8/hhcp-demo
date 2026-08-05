-- ============================================================================
-- Migration 08 — add Deal Team and POG member as grantable per-PortCo roles.
-- (Spec: "HHCP admin can grant a Lead Partner, Deal QB, Ops QB, Deal Team, or
-- POG member access to one or more specific PortCos".) Re-runnable.
-- ============================================================================

ALTER TABLE tenant_memberships DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_role_check
    CHECK (role IN (
        'lead_partner', 'deal_qb', 'ops_qb',
        'portco_management', 'addon_management',
        'deal_team', 'pog_member'
    ));
