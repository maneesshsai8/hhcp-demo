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
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { boolQuery, commandTag } from '../common/fund-access';
import { requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService } from '../database/database.service';

class NewTodoDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() due_date?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsBoolean() is_private?: boolean;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() issue_id?: string | null;
  @IsOptional() @IsString() vcb_id?: string | null;
}

class UpdateTodoDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() due_date?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsString() priority?: string | null;
  @IsOptional() @IsString() status?: string | null;
  @IsOptional() @IsString() completion_note?: string | null;
  @IsOptional() @IsString() issue_id?: string | null;
  @IsOptional() @IsString() vcb_id?: string | null;
}

function shapeTodo(r: Record<string, unknown>): Record<string, unknown> {
  const due = r.due_date as string | null;
  const today = new Date().toISOString().slice(0, 10); // local-ish YYYY-MM-DD
  r.is_overdue = Boolean(due && r.status === 'open' && due < today);
  return r;
}

/** The unified task list + stats + carry-forward. Faithful port of todos.py. */
@Controller('todos')
@UseGuards(AuthGuard)
export class TodosController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listTodos(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('mine') mine?: string,
    @Query('status') status?: string,
    @Query('window') windowParam?: string,
    @Query('owner_id') ownerId?: string,
    @Query('team_id') teamId?: string,
    @Query('overdue_only') overdueOnly?: string,
  ) {
    const target = tenantId || user.active_tenant_id || null;
    const me = boolQuery(mine) ? user.user_id : null;
    const days = windowParam === '7' || windowParam === '90' ? parseInt(windowParam, 10) : null;
    const overdue = boolQuery(overdueOnly);
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT t.id, t.title, t.description, t.due_date, t.status, t.is_private, t.priority,
               t.tenant_id, t.source, t.carried_count, t.completion_note, t.completed_at,
               t.owner_id, t.team_id, t.vcb_id, t.issue_id,
               u.name AS owner_name, tm.name AS team_name,
               v.title AS vcb_title, i.title AS issue_title
        FROM todos t
        LEFT JOIN users u ON u.id = t.owner_id
        LEFT JOIN teams tm ON tm.id = t.team_id
        LEFT JOIN vcbs v ON v.id = t.vcb_id
        LEFT JOIN issues i ON i.id = t.issue_id
        WHERE (${target}::uuid IS NULL OR t.tenant_id = ${target}::uuid)
          AND (${me}::uuid IS NULL OR t.owner_id = ${me}::uuid)
          AND (${ownerId ?? null}::uuid IS NULL OR t.owner_id = ${ownerId ?? null}::uuid)
          AND (${status ?? null}::text IS NULL OR t.status = ${status ?? null}::text)
          AND (${teamId ?? null}::uuid IS NULL OR t.team_id = ${teamId ?? null}::uuid)
          AND (NOT ${overdue} OR (t.status = 'open' AND t.due_date < CURRENT_DATE))
          AND (${days}::int IS NULL OR (t.due_date IS NOT NULL
                 AND t.due_date <= CURRENT_DATE + (${days}::int || ' days')::interval))
        ORDER BY (t.status = 'done'),
                 (t.due_date IS NULL),
                 t.due_date,
                 CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 t.created_at DESC
      `;
    });
    return rows.map((r) => shapeTodo(r as Record<string, unknown>));
  }

  @Get('stats')
  async todoStats(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      const byOwner = await sql`
        SELECT COALESCE(u.name, 'Unassigned') AS name,
               count(*) AS total,
               count(*) FILTER (WHERE t.status = 'done') AS done,
               count(*) FILTER (WHERE t.status = 'open' AND t.due_date < CURRENT_DATE) AS overdue
        FROM todos t LEFT JOIN users u ON u.id = t.owner_id
        WHERE (${target}::uuid IS NULL OR t.tenant_id = ${target}::uuid)
        GROUP BY u.name ORDER BY total DESC
      `;
      const byTeam = await sql`
        SELECT COALESCE(tm.name, 'No team') AS name,
               count(*) AS total,
               count(*) FILTER (WHERE t.status = 'done') AS done
        FROM todos t LEFT JOIN teams tm ON tm.id = t.team_id
        WHERE (${target}::uuid IS NULL OR t.tenant_id = ${target}::uuid)
        GROUP BY tm.name ORDER BY total DESC
      `;
      const rate = (rows: readonly Record<string, unknown>[]) =>
        rows.map((r) => ({
          ...r,
          completion_rate: (r.total as number) ? Math.round(((r.done as number) / (r.total as number)) * 100) : 0,
        }));
      return { by_owner: rate(byOwner), by_team: rate(byTeam) };
    });
  }

  @Post()
  @HttpCode(200)
  async createTodo(@Body() body: NewTodoDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const rows = await sql`
        INSERT INTO todos (tenant_id, title, description, due_date, owner_id, team_id,
                           priority, is_private, source, issue_id, vcb_id)
        VALUES (${body.tenant_id}, ${body.title}, ${body.description ?? null}, ${body.due_date ?? null},
                ${body.owner_id || user.user_id}, ${body.team_id ?? null}, ${body.priority ?? 'medium'},
                ${body.is_private ?? false}, ${body.source ?? 'manual'}, ${body.issue_id ?? null}, ${body.vcb_id ?? null})
        RETURNING id, title, status, tenant_id
      `;
      return rows[0];
    });
  }

  @Patch(':todoId')
  async updateTodo(@Param('todoId') todoId: string, @Body() body: UpdateTodoDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'todos', todoId, 'edit');
      const rows = await sql`
        UPDATE todos SET
            title = COALESCE(${body.title ?? null}, title),
            description = COALESCE(${body.description ?? null}, description),
            due_date = COALESCE(${body.due_date ?? null}, due_date),
            owner_id = COALESCE(${body.owner_id ?? null}, owner_id),
            team_id = COALESCE(${body.team_id ?? null}, team_id),
            priority = COALESCE(${body.priority ?? null}, priority),
            status = COALESCE(${body.status ?? null}, status),
            completion_note = COALESCE(${body.completion_note ?? null}, completion_note),
            issue_id = COALESCE(${body.issue_id ?? null}, issue_id),
            vcb_id = COALESCE(${body.vcb_id ?? null}, vcb_id),
            completed_at = CASE
                WHEN ${body.status ?? null} = 'done' THEN now()
                WHEN ${body.status ?? null} = 'open' THEN NULL
                ELSE completed_at END
        WHERE id = ${todoId}
        RETURNING id, title, status, tenant_id
      `;
      if (!rows[0]) {
        throw new HttpException({ detail: 'To-Do not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      return rows[0];
    });
  }

  @Post('carry-forward')
  @HttpCode(200)
  async carryForward(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id;
    if (!target) {
      throw new HttpException({ detail: 'Pick a tenant to run carry-forward' }, HttpStatus.BAD_REQUEST);
    }
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, String(target), 'edit');
      const rows = await sql`
        SELECT id FROM todos WHERE tenant_id = ${target} AND status = 'open' AND due_date < CURRENT_DATE
      `;
      for (const r of rows) {
        await sql`UPDATE todos SET carried_count = carried_count + 1, last_carried_at = now() WHERE id = ${r.id}`;
        await sql`INSERT INTO carry_forward_log (todo_id, tenant_id, actor_id) VALUES (${r.id}, ${target}, ${user.user_id})`;
      }
      return { carried: rows.length };
    });
  }

  @Delete(':todoId')
  async deleteTodo(@Param('todoId') todoId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'todos', todoId, 'delete');
      const res = await sql`DELETE FROM todos WHERE id = ${todoId}`;
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [TodosController] })
export class TodosModule {}
