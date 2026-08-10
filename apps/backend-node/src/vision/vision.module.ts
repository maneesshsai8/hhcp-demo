import { Body, Controller, Get, Module, Put, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { requireLeadership } from '../common/permissions';
import { DatabaseService } from '../database/database.service';

class VisionDto {
  @IsString() tenant_id!: string;
  @IsOptional() @IsString() mission?: string | null;
  @IsOptional() @IsString() vision?: string | null;
  @IsOptional() @IsString() core_values?: string | null;
}

/**
 * Vision (V/TO) doc per tenant. Faithful port of backend/app/routers/vision.py.
 * Read for anyone who can see the tenant (RLS); write is leadership-only.
 */
@Controller('vision')
@UseGuards(AuthGuard)
export class VisionController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async getVision(@Query('tenant_id') tenantId: string | undefined, @Auth() user: CurrentUser) {
    const target = tenantId || user.active_tenant_id;
    return this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`
        SELECT mission, vision, core_values, updated_at,
               (SELECT name FROM users WHERE id = v.updated_by) AS updated_by_name
        FROM vision_documents v WHERE tenant_id = ${target ?? null}
      `;
      return (
        rows[0] ?? {
          mission: null,
          vision: null,
          core_values: null,
          updated_at: null,
          updated_by_name: null,
        }
      );
    });
  }

  @Put()
  async setVision(@Body() body: VisionDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireLeadership(sql, user.user_id, body.tenant_id);
      await sql`
        INSERT INTO vision_documents (tenant_id, mission, vision, core_values, updated_by, updated_at)
        VALUES (${body.tenant_id}, ${body.mission ?? null}, ${body.vision ?? null},
                ${body.core_values ?? null}, ${user.user_id}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET
          mission = EXCLUDED.mission,
          vision = EXCLUDED.vision,
          core_values = EXCLUDED.core_values,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
      `;
      return { saved: true };
    });
  }
}

@Module({ controllers: [VisionController] })
export class VisionModule {}
