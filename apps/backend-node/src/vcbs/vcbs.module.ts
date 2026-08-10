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
import { IsArray, IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { boolQuery, commandTag } from '../common/fund-access';
import { requireLeadership } from '../common/permissions';
import { DatabaseService } from '../database/database.service';

class NewVcbDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() investment_thesis?: string | null;
  @IsOptional() @IsString() outcome?: string | null;
  @IsOptional() @IsString() start_date?: string | null;
  @IsOptional() @IsString() end_date?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) workstreams?: string[]; // optional initial workstream names
}

class UpdateVcbDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() investment_thesis?: string | null;
  @IsOptional() @IsString() outcome?: string | null;
  @IsOptional() @IsString() start_date?: string | null;
  @IsOptional() @IsString() end_date?: string | null;
  @IsOptional() @IsString() status?: string | null; // 'on_track' | 'off_track' | 'complete'
  @IsOptional() @IsBoolean() archived?: boolean | null;
}

class NewWorkstreamDto {
  @IsString() name!: string;
}

class UpdateWorkstreamDto {
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsInt() sort_order?: number | null;
}

interface Rollup {
  progress_pct: number;
  total_rocks: number;
  complete_rocks: number;
  derived_status: string;
}

/** Roll Rock completion up into a progress % and a derived status. */
function rollup(rocks: ReadonlyArray<{ status: unknown }>): Rollup {
  const total = rocks.length;
  const complete = rocks.filter((r) => r.status === 'complete').length;
  const anyOff = rocks.some((r) => r.status === 'off_track');
  const pct = total ? Math.round((complete / total) * 100) : 0;
  let derived: string;
  if (total && complete === total) derived = 'complete';
  else if (anyOff) derived = 'off_track';
  else derived = 'on_track';
  return { progress_pct: pct, total_rocks: total, complete_rocks: complete, derived_status: derived };
}

/**
 * Value Creation Blueprints (VCBs) + workstreams. Faithful port of
 * backend/app/routers/vcbs.py. Read is anyone who can see the tenant (RLS);
 * all writes are leadership-only.
 */
@Controller('vcbs')
@UseGuards(AuthGuard)
export class VcbsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listVcbs(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('include_archived') includeArchived?: string,
  ) {
    // VCB dashboard: every active VCB with its workstreams and a rolled-up
    // progress % computed live from linked Rocks.
    const target = tenantId || user.active_tenant_id || null;
    const withArchived = boolQuery(includeArchived);
    return this.db.scoped(user.user_id, async (sql) => {
      const vcbs = await sql`
        SELECT v.id, v.tenant_id, v.title, v.description, v.investment_thesis, v.outcome,
               v.start_date, v.end_date, v.status, v.archived,
               o.name AS tenant_name, u.name AS created_by_name
        FROM vcbs v
        JOIN organizations o ON o.id = v.tenant_id
        LEFT JOIN users u ON u.id = v.created_by
        WHERE (${target}::uuid IS NULL OR v.tenant_id = ${target}::uuid)
          AND (${withArchived} OR NOT v.archived)
        ORDER BY v.archived, v.created_at DESC
      `;
      // workstreams for these VCBs
      const ws = await sql`
        SELECT w.id, w.vcb_id, w.name, w.sort_order
        FROM workstreams w
        WHERE (${target}::uuid IS NULL OR w.tenant_id = ${target}::uuid)
        ORDER BY w.sort_order, w.created_at
      `;
      // rocks that ladder up (with their workstream link)
      const rocks = await sql`
        SELECT r.id, r.title, r.status, r.due_date, r.workstream_id, r.tenant_id,
               u.name AS owner_name
        FROM rocks r
        LEFT JOIN users u ON u.id = r.owner_id
        WHERE (${target}::uuid IS NULL OR r.tenant_id = ${target}::uuid) AND r.workstream_id IS NOT NULL
      `;

      const rocksByWs = new Map<string, Array<Record<string, unknown>>>();
      for (const r of rocks) {
        const key = String(r.workstream_id);
        if (!rocksByWs.has(key)) rocksByWs.set(key, []);
        rocksByWs.get(key)!.push({
          id: String(r.id),
          title: r.title,
          status: r.status,
          due_date: r.due_date ?? null,
          owner_name: r.owner_name,
        });
      }

      const wsByVcb = new Map<string, Array<Record<string, unknown>>>();
      for (const w of ws) {
        const wr = rocksByWs.get(String(w.id)) ?? [];
        const key = String(w.vcb_id);
        if (!wsByVcb.has(key)) wsByVcb.set(key, []);
        wsByVcb.get(key)!.push({
          id: String(w.id),
          name: w.name,
          sort_order: w.sort_order,
          rocks: wr,
          ...rollup(wr as Array<{ status: unknown }>),
        });
      }

      return vcbs.map((v) => {
        const streams = wsByVcb.get(String(v.id)) ?? [];
        const allRocks = streams.flatMap((s) => s.rocks as Array<{ status: unknown }>);
        const roll = rollup(allRocks);
        return {
          id: String(v.id),
          tenant_id: String(v.tenant_id),
          tenant_name: v.tenant_name,
          title: v.title,
          description: v.description,
          investment_thesis: v.investment_thesis,
          outcome: v.outcome,
          start_date: v.start_date ?? null,
          end_date: v.end_date ?? null,
          status: v.status,
          archived: v.archived,
          created_by_name: v.created_by_name,
          workstreams: streams,
          ...roll,
        };
      });
    });
  }

  @Post()
  @HttpCode(200)
  async createVcb(@Body() body: NewVcbDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireLeadership(sql, user.user_id, body.tenant_id);
      const rows = await sql`
        INSERT INTO vcbs (tenant_id, title, description, investment_thesis, outcome,
                          start_date, end_date, created_by)
        VALUES (${body.tenant_id}, ${body.title}, ${body.description ?? null}, ${body.investment_thesis ?? null},
                ${body.outcome ?? null}, ${body.start_date ?? null}, ${body.end_date ?? null}, ${user.user_id})
        RETURNING id, title, status
      `;
      const row = rows[0];
      const workstreams = body.workstreams ?? [];
      for (let i = 0; i < workstreams.length; i++) {
        const name = workstreams[i];
        if (name.trim()) {
          await sql`
            INSERT INTO workstreams (vcb_id, tenant_id, name, sort_order)
            VALUES (${row.id}, ${body.tenant_id}, ${name.trim()}, ${i})
          `;
        }
      }
      await auditLog(sql, user.user_id, 'vcb.create', {
        entityType: 'vcb',
        entityId: row.id,
        tenantId: body.tenant_id,
        detail: body.title,
      });
      return { id: String(row.id), title: row.title, status: row.status };
    });
  }

  @Patch(':vcbId')
  async updateVcb(@Param('vcbId') vcbId: string, @Body() body: UpdateVcbDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM vcbs WHERE id = ${vcbId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'VCB not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(tenantId));
      const bRows = await sql`SELECT status FROM vcbs WHERE id = ${vcbId}`;
      const before = bRows[0]?.status as string | undefined;
      const rows = await sql`
        UPDATE vcbs SET
            title             = COALESCE(${body.title ?? null}, title),
            description       = COALESCE(${body.description ?? null}, description),
            investment_thesis = COALESCE(${body.investment_thesis ?? null}, investment_thesis),
            outcome           = COALESCE(${body.outcome ?? null}, outcome),
            start_date        = COALESCE(${body.start_date ?? null}, start_date),
            end_date          = COALESCE(${body.end_date ?? null}, end_date),
            status            = COALESCE(${body.status ?? null}, status),
            archived          = COALESCE(${body.archived ?? null}, archived)
        WHERE id = ${vcbId}
        RETURNING id, title, status, archived
      `;
      const row = rows[0];
      // Emit a status-change event (day-one feed for the Phase 2 compliance dashboard).
      if (body.status && body.status !== before) {
        await auditLog(sql, user.user_id, 'vcb.status', {
          entityType: 'vcb',
          entityId: vcbId,
          tenantId: String(tenantId),
          detail: `${row.title}: ${before} → ${body.status}`,
        });
      } else {
        await auditLog(sql, user.user_id, 'vcb.edit', {
          entityType: 'vcb',
          entityId: vcbId,
          tenantId: String(tenantId),
          detail: row.title,
        });
      }
      return { id: String(row.id), title: row.title, status: row.status, archived: row.archived };
    });
  }

  @Delete(':vcbId')
  async deleteVcb(@Param('vcbId') vcbId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM vcbs WHERE id = ${vcbId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'VCB not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(tenantId));
      const result = await sql`DELETE FROM vcbs WHERE id = ${vcbId}`;
      await auditLog(sql, user.user_id, 'vcb.delete', {
        entityType: 'vcb',
        entityId: vcbId,
        tenantId: String(tenantId),
      });
      return { deleted: commandTag(result) };
    });
  }

  // ---------------------------------------------------------------- workstreams --
  @Post(':vcbId/workstreams')
  @HttpCode(200)
  async addWorkstream(
    @Param('vcbId') vcbId: string,
    @Body() body: NewWorkstreamDto,
    @Auth() user: CurrentUser,
  ) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM vcbs WHERE id = ${vcbId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'VCB not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(tenantId));
      const nxtRows = await sql`SELECT COALESCE(MAX(sort_order) + 1, 0) AS nxt FROM workstreams WHERE vcb_id = ${vcbId}`;
      const nxt = nxtRows[0]?.nxt;
      const rows = await sql`
        INSERT INTO workstreams (vcb_id, tenant_id, name, sort_order)
        VALUES (${vcbId}, ${tenantId}, ${body.name}, ${nxt})
        RETURNING id, name
      `;
      return { id: String(rows[0].id), name: rows[0].name };
    });
  }

  @Patch('workstreams/:wsId')
  async updateWorkstream(
    @Param('wsId') wsId: string,
    @Body() body: UpdateWorkstreamDto,
    @Auth() user: CurrentUser,
  ) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM workstreams WHERE id = ${wsId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'Workstream not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(tenantId));
      const rows = await sql`
        UPDATE workstreams SET name = COALESCE(${body.name ?? null}, name),
                               sort_order = COALESCE(${body.sort_order ?? null}, sort_order)
        WHERE id = ${wsId} RETURNING id, name
      `;
      return { id: String(rows[0].id), name: rows[0].name };
    });
  }

  @Delete('workstreams/:wsId')
  async deleteWorkstream(@Param('wsId') wsId: string, @Auth() user: CurrentUser) {
    // Deleting a workstream un-links its Rocks (ON DELETE SET NULL) — the Rocks survive.
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM workstreams WHERE id = ${wsId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'Workstream not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(tenantId));
      const result = await sql`DELETE FROM workstreams WHERE id = ${wsId}`;
      return { deleted: commandTag(result) };
    });
  }
}

@Module({ controllers: [VcbsController] })
export class VcbsModule {}
