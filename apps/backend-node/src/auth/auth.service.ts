import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface AccessibleTenant {
  id: string;
  name: string;
  tenant_type: string;
  parent_tenant_id: string | null;
  role: string | null;
}

/**
 * DB-facing auth logic shared by the controller. Faithful port of the helper
 * functions in backend/app/routers/auth.py.
 */
@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Live lookup — always the current source of truth, never a cached claim.
   * Mirrors `_accessible_tenants_for`.
   */
  async accessibleTenantsFor(
    userId: string,
  ): Promise<{ tenants: AccessibleTenant[]; isFundAdmin: boolean }> {
    return this.db.scoped(userId, async (sql) => {
      const rows = await sql`
        SELECT o.id, o.name, o.tenant_type, o.parent_tenant_id,
               user_role_for_tenant(${userId}, o.id) AS role
        FROM organizations o
        ORDER BY o.tenant_type, o.name
      `;
      const adminRows = await sql`
        SELECT COALESCE(is_fund_admin, false) AS is_fund_admin FROM users WHERE id = ${userId}
      `;
      const tenants: AccessibleTenant[] = rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        tenant_type: r.tenant_type,
        parent_tenant_id: r.parent_tenant_id ? String(r.parent_tenant_id) : null,
        role: (r.role as string | null) ?? null,
      }));
      return { tenants, isFundAdmin: Boolean(adminRows[0]?.is_fund_admin) };
    });
  }

  /**
   * Invite-only: a user must be pre-created by an admin before they can log in.
   * Mirrors `_ensure_app_user`. users has no RLS → unscoped connection.
   */
  async ensureAppUser(claims: { sub?: string; email?: string }): Promise<string> {
    const sub = claims.sub;
    const email = (claims.email ?? '').toLowerCase();
    const sql = this.db.unscoped;

    const linked = await sql`SELECT id FROM users WHERE supabase_uid = ${String(sub)}`;
    if (linked[0]) return String(linked[0].id);

    const existing = await sql`
      SELECT id FROM users WHERE lower(email) = ${email} AND supabase_uid IS NULL
    `;
    if (existing[0]) {
      await sql`UPDATE users SET supabase_uid = ${String(sub)} WHERE id = ${existing[0].id}`;
      return String(existing[0].id);
    }

    throw new HttpException(
      {
        detail:
          "This account isn't set up yet. Ask an administrator to create your user first.",
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
