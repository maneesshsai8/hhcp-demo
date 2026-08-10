import { HttpException, HttpStatus } from '@nestjs/common';
import { ScopedSql } from '../database/database.service';

/**
 * Role -> action permission matrix (RBAC). Faithful port of
 * backend/app/permissions.py. Access to a tenant is decided by RLS
 * (user_accessible_tenants); this layer decides what you may DO once you're in.
 *
 * Effective role for a tenant is resolved by the SQL function
 * user_role_for_tenant() — fund staff are 'fund_admin' everywhere, everyone else
 * inherits the role of the nearest granted ancestor (so add-ons inherit the
 * PortCo grant's role). That function is DB-resident and unchanged.
 */

export type Action = 'view' | 'create' | 'edit' | 'delete' | 'provision';

export const ROLE_PERMISSIONS: Record<string, Set<Action>> = {
  fund_admin: new Set(['view', 'create', 'edit', 'delete', 'provision']),
  lead_partner: new Set(['view', 'create', 'edit', 'delete']),
  deal_qb: new Set(['view', 'create', 'edit', 'delete']),
  portco_management: new Set(['view', 'create', 'edit', 'delete']),
  ops_qb: new Set(['view', 'create', 'edit']), // cannot delete
  addon_management: new Set(['view', 'create', 'edit']), // cannot delete
  deal_team: new Set(['view', 'create', 'edit']), // contributor, no delete
  pog_member: new Set(['view']), // read-only observer
  manager: new Set(['view', 'create', 'edit', 'delete']), // + data scoped to own + reports (RLS)
  team_member: new Set(['view', 'create', 'edit']), // + data scoped to own records (RLS)
  read_only: new Set(['view']), // view-only
};

// VCBs are HHCP's strategic layer — only leadership defines them.
export const LEADERSHIP_ROLES = new Set([
  'fund_admin',
  'lead_partner',
  'deal_qb',
  'portco_management',
]);

function forbidden(detail: string): never {
  throw new HttpException({ detail }, HttpStatus.FORBIDDEN);
}

function notFound(detail: string): never {
  throw new HttpException({ detail }, HttpStatus.NOT_FOUND);
}

export async function effectiveRole(
  sql: ScopedSql,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const rows = await sql`SELECT user_role_for_tenant(${userId}, ${tenantId}) AS role`;
  return (rows[0]?.role as string | null) ?? null;
}

/** Raise 403 unless the user's effective role for this tenant allows `action`. */
export async function requirePermission(
  sql: ScopedSql,
  userId: string,
  tenantId: string,
  action: Action,
): Promise<string> {
  const role = await effectiveRole(sql, userId, tenantId);
  if (role === null || !ROLE_PERMISSIONS[role]?.has(action)) {
    forbidden(`Your role (${role ?? 'no access'}) is not allowed to ${action} in this tenant`);
  }
  return role;
}

export async function requireLeadership(
  sql: ScopedSql,
  userId: string,
  tenantId: string,
): Promise<string> {
  const role = await effectiveRole(sql, userId, tenantId);
  if (role === null || !LEADERSHIP_ROLES.has(role)) {
    forbidden(
      `Only leadership (fund admin / lead partner / deal QB / portco management) can manage VCBs — your role is ${role ?? 'no access'}`,
    );
  }
  return role;
}

/**
 * For edit/delete: look up the row's tenant_id, then check `action`. RLS has
 * already guaranteed the row is one the caller can see, so a missing row means
 * 404. `table` is an internal literal, never user input.
 */
export async function requireRowPermission(
  sql: ScopedSql,
  userId: string,
  table: string,
  rowId: string,
  action: Action,
): Promise<string> {
  // `table` is a trusted internal literal (mirrors the Python f-string usage).
  const rows = await sql`SELECT tenant_id FROM ${sql(table)} WHERE id = ${rowId}`;
  const tenantId = rows[0]?.tenant_id as string | undefined;
  if (tenantId == null) {
    notFound('Not found or not accessible');
  }
  await requirePermission(sql, userId, String(tenantId), action);
  return String(tenantId);
}
