import { ScopedSql } from '../database/database.service';

/**
 * Transactional outbox writer. Faithful port of backend/app/outbox.py.
 *
 * `emit()` INSERTs a durable event row on the SAME transaction as the domain
 * change that produced it. Because DatabaseService.scoped() wraps each request
 * in a single transaction, the domain write and its outbox event either both
 * commit or both roll back — no window where the meeting is completed but the
 * event was lost. A separate worker (apps/backend-node-worker) drains
 * meeting_outbox after commit and fans out.
 */
export async function emit(
  sql: ScopedSql,
  eventType: string,
  opts: {
    aggregateId: string;
    tenantId?: string | null;
    payload?: Record<string, unknown> | null;
    eventVersion?: number;
    aggregateType?: string;
  },
): Promise<string> {
  const rows = await sql`
    INSERT INTO meeting_outbox (event_type, event_version, aggregate_type, aggregate_id, tenant_id, payload)
    VALUES (
      ${eventType},
      ${opts.eventVersion ?? 1},
      ${opts.aggregateType ?? 'meeting'},
      ${opts.aggregateId},
      ${opts.tenantId ?? null},
      ${sql.json((opts.payload ?? {}) as never)}
    )
    RETURNING event_id
  `;
  return String(rows[0].event_id);
}
