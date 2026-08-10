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
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { boolQuery, commandTag } from '../common/fund-access';
import { requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService } from '../database/database.service';

class NewIssueDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsString() priority?: string | null; // 'low' | 'medium' | 'high'
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsString() vcb_id?: string | null;
}

class UpdateIssueDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() status?: string | null; // 'open' | 'solved'
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsString() priority?: string | null;
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsString() vcb_id?: string | null;
  @IsOptional() @IsString() resolution_note?: string | null;
  @IsOptional() @IsBoolean() archived?: boolean | null;
}

class ReorderDto {
  @IsArray() @IsString({ each: true }) order!: string[]; // issue_ids in the desired priority order
}

/** Company/team issue board + velocity stats + drag-rank reorder. Faithful port of issues.py. */
@Controller('issues')
@UseGuards(AuthGuard)
export class IssuesController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listIssues(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('team_id') teamId?: string,
    @Query('status') status?: string,
    @Query('include_archived') includeArchived?: string,
  ) {
    const target = tenantId || user.active_tenant_id || null;
    const include = boolQuery(includeArchived);
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT i.id, i.title, i.description, i.status, i.tenant_id, i.created_at, i.priority,
               i.category, i.sort_order, i.resolution_note, i.solved_at, i.archived,
               i.owner_id, i.team_id, i.vcb_id,
               u.name AS created_by_name, o.name AS owner_name,
               t.name AS team_name, v.title AS vcb_title
        FROM issues i
        LEFT JOIN users u ON u.id = i.created_by
        LEFT JOIN users o ON o.id = i.owner_id
        LEFT JOIN teams t ON t.id = i.team_id
        LEFT JOIN vcbs v ON v.id = i.vcb_id
        WHERE (${target}::uuid IS NULL OR i.tenant_id = ${target}::uuid)
          AND (${teamId ?? null}::uuid IS NULL OR i.team_id = ${teamId ?? null}::uuid)
          AND (${status ?? null}::text IS NULL OR i.status = ${status ?? null}::text)
          AND (${include} OR NOT i.archived)
        ORDER BY (i.status = 'solved'),
                 CASE WHEN i.status = 'open' THEN i.sort_order END,
                 i.solved_at DESC NULLS LAST
      `;
    });
  }

  @Get('stats')
  async issueStats(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      const totalsRows = await sql`
        SELECT count(*) FILTER (WHERE status = 'open') AS open,
               count(*) FILTER (WHERE status = 'solved') AS solved,
               avg(EXTRACT(EPOCH FROM (solved_at - created_at)) / 86400.0)
                   FILTER (WHERE status = 'solved') AS avg_days
        FROM issues
        WHERE (${target}::uuid IS NULL OR tenant_id = ${target}::uuid)
      `;
      const totals = totalsRows[0];
      const velocity = await sql`
        SELECT to_char(date_trunc('week', solved_at), 'YYYY-MM-DD') AS week,
               count(*) AS resolved
        FROM issues
        WHERE status = 'solved' AND solved_at > now() - interval '8 weeks'
          AND (${target}::uuid IS NULL OR tenant_id = ${target}::uuid)
        GROUP BY 1 ORDER BY 1
      `;
      const avgDays = totals.avg_days;
      return {
        open: totals.open,
        solved: totals.solved,
        avg_days_to_resolve: avgDays != null ? Math.round(Number(avgDays) * 10) / 10 : null,
        velocity,
      };
    });
  }

  @Post()
  @HttpCode(200)
  async createIssue(@Body() body: NewIssueDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      // new issues rank to the top of the open list (highest priority)
      await sql`
        UPDATE issues SET sort_order = sort_order + 1 WHERE tenant_id = ${body.tenant_id} AND status = 'open'
      `;
      const rows = await sql`
        INSERT INTO issues (tenant_id, title, description, created_by, owner_id, team_id,
                            priority, category, vcb_id, sort_order)
        VALUES (${body.tenant_id}, ${body.title}, ${body.description ?? null}, ${user.user_id},
                ${body.owner_id ?? null}, ${body.team_id ?? null}, ${body.priority ?? null},
                ${body.category ?? null}, ${body.vcb_id ?? null}, 0)
        RETURNING id, title, status, tenant_id
      `;
      return rows[0];
    });
  }

  @Patch(':issueId')
  async updateIssue(@Param('issueId') issueId: string, @Body() body: UpdateIssueDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'issues', issueId, 'edit');
      const beforeRows = await sql`SELECT status FROM issues WHERE id = ${issueId}`;
      const before = beforeRows[0]?.status as string | undefined;
      const rows = await sql`
        UPDATE issues SET
            title = COALESCE(${body.title ?? null}, title),
            description = COALESCE(${body.description ?? null}, description),
            status = COALESCE(${body.status ?? null}, status),
            team_id = COALESCE(${body.team_id ?? null}, team_id),
            owner_id = COALESCE(${body.owner_id ?? null}, owner_id),
            priority = COALESCE(${body.priority ?? null}, priority),
            category = COALESCE(${body.category ?? null}, category),
            vcb_id = COALESCE(${body.vcb_id ?? null}, vcb_id),
            resolution_note = COALESCE(${body.resolution_note ?? null}, resolution_note),
            archived = COALESCE(${body.archived ?? null}, archived),
            solved_at = CASE
                WHEN ${body.status ?? null} = 'solved' THEN now()
                WHEN ${body.status ?? null} = 'open' THEN NULL
                ELSE solved_at END
        WHERE id = ${issueId}
        RETURNING id, title, status, tenant_id
      `;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'Issue not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      if (body.status && body.status !== before) {
        await auditLog(sql, user.user_id, 'issue.status', {
          entityType: 'issue',
          entityId: issueId,
          tenantId: String(tenantId),
          detail: `${row.title}: ${before} → ${body.status}`,
        });
      }
      return row;
    });
  }

  @Post('reorder')
  @HttpCode(200)
  async reorderIssues(@Body() body: ReorderDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      for (let idx = 0; idx < body.order.length; idx++) {
        await sql`UPDATE issues SET sort_order = ${idx} WHERE id = ${body.order[idx]}`;
      }
      return { reordered: body.order.length };
    });
  }

  @Delete(':issueId')
  async deleteIssue(@Param('issueId') issueId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'issues', issueId, 'delete');
      const res = await sql`DELETE FROM issues WHERE id = ${issueId}`;
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [IssuesController] })
export class IssuesModule {}
