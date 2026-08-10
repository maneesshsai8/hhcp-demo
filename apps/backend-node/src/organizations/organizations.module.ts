import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Module,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { commandTag, requireFundAdmin, requireFundView } from '../common/fund-access';
import { DatabaseService } from '../database/database.service';

class CreateOrgDto {
  @IsString() name!: string;
  @IsString() tenant_type!: string;
  @IsOptional() @IsString() parent_tenant_id?: string | null;
  @IsOptional() @IsString() fund_label?: string | null;
  @IsOptional() @IsString() acquisition_date?: string | null;
  @IsOptional() @IsString() transaction_type?: string | null;
}

class UpdateOrgDto {
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() fund_label?: string | null;
  @IsOptional() @IsString() acquisition_date?: string | null;
  @IsOptional() @IsString() transaction_type?: string | null;
  @IsOptional() @IsString() exit_date?: string | null;
}

class GrantDto {
  @IsString() user_id!: string;
  @IsString() role!: string;
  @IsOptional() @IsString() tenant_id?: string | null;
  @IsOptional() @IsArray() tenant_ids?: string[] | null;
}

/** PortCo provisioning + Tier-2 grants. Faithful port of organizations.py. */
@Controller('organizations')
@UseGuards(AuthGuard)
export class OrganizationsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listOrganizations(@Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT id, name, tenant_type, parent_tenant_id, fund_label,
               acquisition_date, transaction_type, exit_date
        FROM organizations
        ORDER BY tenant_type, name
      `;
    });
  }

  @Post()
  @HttpCode(200)
  async createOrganization(@Body() body: CreateOrgDto, @Auth() user: CurrentUser) {
    // Generate the id in the app rather than via RETURNING: user_accessible_tenants()
    // is STABLE, so under the INSERT's snapshot it can't yet see the new row and a
    // RETURNING SELECT would fail this table's own RLS policy.
    const newId = randomUUID();
    const parent = body.parent_tenant_id ? String(body.parent_tenant_id) : null;
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      await sql`
        INSERT INTO organizations (id, name, tenant_type, parent_tenant_id, fund_label, acquisition_date, transaction_type)
        VALUES (${newId}, ${body.name}, ${body.tenant_type}, ${parent}, ${body.fund_label ?? null},
                ${body.acquisition_date ?? null}, ${body.transaction_type ?? null})
      `;
      await auditLog(sql, user.user_id, 'organization.create', {
        entityType: 'organization',
        entityId: newId,
        tenantId: newId,
        detail: `${body.name} (${body.tenant_type})`,
      });
      return { id: newId, name: body.name, tenant_type: body.tenant_type, parent_tenant_id: parent };
    });
  }

  @Patch(':orgId')
  async updateOrganization(@Param('orgId') orgId: string, @Body() body: UpdateOrgDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      const rows = await sql`
        UPDATE organizations SET
            name             = COALESCE(${body.name ?? null}, name),
            fund_label       = COALESCE(${body.fund_label ?? null}, fund_label),
            acquisition_date = COALESCE(${body.acquisition_date ?? null}, acquisition_date),
            transaction_type = COALESCE(${body.transaction_type ?? null}, transaction_type),
            exit_date        = COALESCE(${body.exit_date ?? null}, exit_date)
        WHERE id = ${orgId}
        RETURNING id, name, tenant_type, parent_tenant_id, fund_label,
                  acquisition_date, transaction_type, exit_date
      `;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'Organization not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await auditLog(sql, user.user_id, 'organization.edit', {
        entityType: 'organization',
        entityId: orgId,
        tenantId: orgId,
        detail: row.name,
      });
      return row;
    });
  }

  @Get('grants')
  async listGrants(@Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundView(sql, user.user_id);
      return sql`
        SELECT tm.id, tm.role, tm.user_id, tm.tenant_id,
               u.name AS user_name, u.email AS user_email,
               o.name AS tenant_name, o.tenant_type, o.parent_tenant_id
        FROM tenant_memberships tm
        JOIN users u ON u.id = tm.user_id
        JOIN organizations o ON o.id = tm.tenant_id
        ORDER BY u.name, o.name
      `;
    });
  }

  @Post('grants')
  @HttpCode(200)
  async grantTenantAccess(@Body() body: GrantDto, @Auth() user: CurrentUser) {
    const targets = (body.tenant_ids && body.tenant_ids.length ? body.tenant_ids : body.tenant_id ? [body.tenant_id] : []).filter(
      (t): t is string => Boolean(t),
    );
    if (targets.length === 0) {
      throw new HttpException({ detail: 'Pick at least one PortCo to grant access to' }, HttpStatus.BAD_REQUEST);
    }
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      const granted: Record<string, unknown>[] = [];
      for (const tid of targets) {
        const rows = await sql`
          INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by)
          VALUES (${body.user_id}, ${tid}, ${body.role}, ${user.user_id})
          ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
          RETURNING id, user_id, tenant_id, role
        `;
        const row = rows[0];
        await auditLog(sql, user.user_id, 'grant', {
          entityType: 'tenant_membership',
          entityId: String(row.id),
          tenantId: tid,
          detail: `role=${body.role}`,
        });
        granted.push(row);
      }
      return { granted: granted.length, memberships: granted };
    });
  }

  @Delete('grants/:membershipId')
  async revokeTenantAccess(@Param('membershipId') membershipId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      const res = await sql`DELETE FROM tenant_memberships WHERE id = ${membershipId}`;
      await auditLog(sql, user.user_id, 'revoke', { entityType: 'tenant_membership', entityId: membershipId });
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [OrganizationsController] })
export class OrganizationsModule {}
