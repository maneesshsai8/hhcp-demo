import { ScopedSql } from '../database/database.service';

/**
 * Tiny audit-log helper. Faithful port of backend/app/audit.py. Every meaningful
 * action (logins, user edits, grants, provisioning) calls log() so the admin
 * audit trail is complete. audit_log has no RLS — it's a compliance record that
 * deliberately spans tenants and is only exposed to fund admins via the app.
 */
export async function auditLog(
  sql: ScopedSql,
  actorId: string | null,
  action: string,
  opts: {
    entityType?: string | null;
    entityId?: string | null;
    tenantId?: string | null;
    detail?: string | null;
  } = {},
): Promise<void> {
  let actorName: string | null = null;
  if (actorId) {
    const rows = await sql`SELECT name FROM users WHERE id = ${actorId}`;
    actorName = (rows[0]?.name as string | null) ?? null;
  }
  await sql`
    INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, tenant_id, detail)
    VALUES (
      ${actorId},
      ${actorName},
      ${action},
      ${opts.entityType ?? null},
      ${opts.entityId ?? null},
      ${opts.tenantId ?? null},
      ${opts.detail ?? null}
    )
  `;
}
