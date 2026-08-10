import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { Auth, CurrentUser } from '../auth/current-user';
import { AuthGuard } from '../auth/auth.guard';
import { DatabaseService } from '../database/database.service';

/**
 * GET /directory — assignable users (owner dropdowns). Faithful port of
 * backend/app/routers/directory.py. Uses the SECURITY DEFINER helper
 * assignable_users(), the only sanctioned way to see across the private
 * tenant_memberships roster within tenants you can already reach.
 */
@Controller('directory')
@UseGuards(AuthGuard)
export class DirectoryController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async directory(@Query('tenant_id') tenantId: string | undefined, @Auth() user: CurrentUser) {
    const scope = tenantId || user.active_tenant_id;
    return this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`
        SELECT id, name, email FROM assignable_users(${user.user_id}::uuid, ${scope ?? null}::uuid)
      `;
      return rows.map((r) => ({ id: String(r.id), name: r.name, email: r.email }));
    });
  }
}

@Module({ controllers: [DirectoryController] })
export class DirectoryModule {}
