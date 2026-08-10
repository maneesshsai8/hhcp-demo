import { HttpException, HttpStatus } from '@nestjs/common';
import { ScopedSql } from '../database/database.service';

/**
 * Fund-level gates. Faithful ports of the `_require_fund_admin` /
 * `_require_fund_view` helpers duplicated in users.py and organizations.py.
 * `users` has no RLS, so these are enforced at the app layer.
 */

function forbidden(detail: string): never {
  throw new HttpException({ detail }, HttpStatus.FORBIDDEN);
}

/** Tier-1 admin only (grant/provision/mutate). */
export async function requireFundAdmin(sql: ScopedSql, userId: string): Promise<void> {
  const rows = await sql`SELECT COALESCE(is_fund_admin, false) AS ok FROM users WHERE id = ${userId}`;
  if (!rows[0]?.ok) forbidden('Only Hidden Harbor fund admins can do this');
}

/** Read access to the fund dashboard: fund admins OR fund viewers. */
export async function requireFundView(sql: ScopedSql, userId: string): Promise<void> {
  const rows = await sql`
    SELECT (COALESCE(is_fund_admin, false) OR COALESCE(is_fund_viewer, false)) AS ok
    FROM users WHERE id = ${userId}
  `;
  if (!rows[0]?.ok) forbidden('Fund-level access required');
}

/** asyncpg-style command tag ("DELETE 1", "UPDATE 0") for `{ deleted }`/`{ updated }` parity. */
export function commandTag(result: { command?: string; count?: number }): string {
  return `${result.command ?? ''} ${result.count ?? 0}`.trim();
}

/** Coerce a query-string boolean the way FastAPI does ('true'/'1'/'yes' → true). */
export function boolQuery(v: unknown): boolean {
  if (typeof v !== 'string') return Boolean(v);
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}
