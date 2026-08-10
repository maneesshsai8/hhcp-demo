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
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { commandTag } from '../common/fund-access';
import { requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService, ScopedSql } from '../database/database.service';

class NewRockDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() due_date?: string | null;
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() owner_id?: string | null; // kept for back-compat (single owner)
  @IsOptional() @IsArray() assignee_ids?: string[] | null; // multi-assignee; first becomes primary owner
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() workstream_id?: string | null; // ladders this Rock up to a VCB workstream
}

class UpdateRockDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() status?: string | null; // 'on_track' | 'off_track' | 'complete'
  @IsOptional() @IsString() due_date?: string | null;
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsArray() assignee_ids?: string[] | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() workstream_id?: string | null;
}

/** Replace a rock's assignee set. Returns the primary (first) assignee id. */
async function syncAssignees(
  sql: ScopedSql,
  rockId: string,
  tenantId: string,
  assigneeIds: string[],
): Promise<string | null> {
  await sql`DELETE FROM rock_assignees WHERE rock_id = ${rockId}`;
  const seen: string[] = [];
  for (const uid of assigneeIds) {
    if (uid && !seen.includes(uid)) {
      await sql`
        INSERT INTO rock_assignees (rock_id, user_id, tenant_id)
        VALUES (${rockId}, ${uid}, ${tenantId})
        ON CONFLICT (rock_id, user_id) DO NOTHING
      `;
      seen.push(uid);
    }
  }
  return seen.length ? seen[0] : null;
}

/** Rocks — quarterly priorities with multi-assignee + VCB laddering. Faithful port of rocks.py. */
@Controller('rocks')
@UseGuards(AuthGuard)
export class RocksController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listRocks(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT r.id, r.title, r.status, r.due_date, r.tenant_id, r.description,
               r.owner_id, u.name AS owner_name, t.name AS team_name,
               r.workstream_id, w.name AS workstream_name, w.vcb_id, v.title AS vcb_title,
               COALESCE(
                 (SELECT json_agg(json_build_object('id', ra.user_id, 'name', au.name) ORDER BY au.name)
                  FROM rock_assignees ra JOIN users au ON au.id = ra.user_id
                  WHERE ra.rock_id = r.id),
                 '[]'::json) AS assignees
        FROM rocks r
        LEFT JOIN users u ON u.id = r.owner_id
        LEFT JOIN teams t ON t.id = r.team_id
        LEFT JOIN workstreams w ON w.id = r.workstream_id
        LEFT JOIN vcbs v ON v.id = w.vcb_id
        WHERE (${target}::uuid IS NULL OR r.tenant_id = ${target}::uuid)
        ORDER BY r.status, r.due_date
      `;
    });
  }

  @Post()
  @HttpCode(200)
  async createRock(@Body() body: NewRockDto, @Auth() user: CurrentUser) {
    let assignees =
      body.assignee_ids != null
        ? body.assignee_ids
        : body.owner_id
          ? [body.owner_id]
          : [user.user_id];
    assignees = assignees.filter((a) => a);
    if (assignees.length === 0) assignees = [user.user_id];
    const primary = assignees[0];
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const rows = await sql`
        INSERT INTO rocks (tenant_id, title, owner_id, due_date, team_id, description, workstream_id)
        VALUES (${body.tenant_id}, ${body.title}, ${primary},
                ${body.due_date ?? null}, ${body.team_id ?? null}, ${body.description ?? null}, ${body.workstream_id ?? null})
        RETURNING id, title, status, due_date, tenant_id
      `;
      await syncAssignees(sql, rows[0].id as string, body.tenant_id, assignees);
      return rows[0];
    });
  }

  @Patch(':rockId')
  async updateRock(@Param('rockId') rockId: string, @Body() body: UpdateRockDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'rocks', rockId, 'edit');
      const beforeRows = await sql`SELECT status FROM rocks WHERE id = ${rockId}`;
      const before = (beforeRows[0]?.status as string | null) ?? null;

      // If a new assignee set is given, the primary owner follows the first one.
      let primary: string | null = null;
      if (body.assignee_ids != null) {
        primary = await syncAssignees(sql, rockId, String(tenantId), body.assignee_ids);
      }
      const ownerOverride = primary || body.owner_id || null;

      const rows = await sql`
        UPDATE rocks SET
            title = COALESCE(${body.title ?? null}, title),
            status = COALESCE(${body.status ?? null}, status),
            due_date = COALESCE(${body.due_date ?? null}, due_date),
            team_id = COALESCE(${body.team_id ?? null}, team_id),
            owner_id = COALESCE(${ownerOverride}, owner_id),
            description = COALESCE(${body.description ?? null}, description),
            workstream_id = COALESCE(${body.workstream_id ?? null}, workstream_id)
        WHERE id = ${rockId}
        RETURNING id, title, status, due_date, tenant_id
      `;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'Rock not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      // Emit a Rock status-change event — rolls up to workstream/VCB, and feeds the
      // Phase 2 OS Compliance Dashboard from day one.
      if (body.status && body.status !== before) {
        await auditLog(sql, user.user_id, 'rock.status', {
          entityType: 'rock',
          entityId: rockId,
          tenantId: String(tenantId),
          detail: `${row.title}: ${before} → ${body.status}`,
        });
      }
      return row;
    });
  }

  @Delete(':rockId')
  async deleteRock(@Param('rockId') rockId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'rocks', rockId, 'delete');
      const res = await sql`DELETE FROM rocks WHERE id = ${rockId}`;
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [RocksController] })
export class RocksModule {}
