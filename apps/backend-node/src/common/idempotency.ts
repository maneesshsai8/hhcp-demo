import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { ScopedSql } from '../database/database.service';

/**
 * Idempotency for retryable commands (start/complete meeting, inline issue/todo).
 * Faithful port of backend/app/idempotency.py.
 *
 *   const prior = await lookup(sql, userId, 'meeting.complete', key, bodyStr);
 *   if (prior !== null) return prior;   // replay original response, no dup effect
 *   ... do the work ...
 *   await save(sql, userId, 'meeting.complete', key, bodyStr, { tenantId, status: 200, response: result });
 *   return result;
 *
 * The whole request is one transaction, so the idempotency row commits
 * atomically with the effect. Reusing a key with a DIFFERENT payload → 409.
 */
const TTL_HOURS = 48;

function hashBody(body: string | Buffer | null): string {
  return createHash('sha256')
    .update(body ?? '')
    .digest('hex');
}

/**
 * Returns the stored response if this exact command was already run, else null.
 * Throws 409 if the key was used with a different payload. No-op (null) without a key.
 */
export async function lookup(
  sql: ScopedSql,
  userId: string,
  command: string,
  key: string | null | undefined,
  body: string | Buffer | null,
): Promise<unknown | null> {
  if (!key) return null;
  const rows = await sql`
    SELECT request_hash, response_body FROM meeting_idempotency
    WHERE user_id = ${userId} AND command_name = ${command} AND idempotency_key = ${key}
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.request_hash !== hashBody(body)) {
    throw new HttpException(
      { detail: 'Idempotency-Key reused with a different request' },
      HttpStatus.CONFLICT,
    );
  }
  // postgres.js parses jsonb columns to JS objects automatically.
  return typeof row.response_body === 'string'
    ? JSON.parse(row.response_body)
    : row.response_body;
}

/** Persist the command's response so a retry replays it. No-op without a key. */
export async function save(
  sql: ScopedSql,
  userId: string,
  command: string,
  key: string | null | undefined,
  body: string | Buffer | null,
  opts: { tenantId?: string | null; status?: number; response?: Record<string, unknown> | null } = {},
): Promise<void> {
  if (!key) return;
  await sql`
    INSERT INTO meeting_idempotency
      (tenant_id, user_id, command_name, idempotency_key, request_hash, response_status, response_body, expires_at)
    VALUES (
      ${opts.tenantId ?? null},
      ${userId},
      ${command},
      ${key},
      ${hashBody(body)},
      ${opts.status ?? 200},
      ${sql.json((opts.response ?? {}) as never)},
      now() + (${String(TTL_HOURS)} || ' hours')::interval
    )
    ON CONFLICT (user_id, command_name, idempotency_key) DO NOTHING
  `;
}
