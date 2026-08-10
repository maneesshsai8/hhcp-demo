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
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { commandTag } from '../common/fund-access';
import { requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService, ScopedSql } from '../database/database.service';

class NewScoreDto {
  @IsDateString() recorded_at!: string;
  @IsNumber() actual_value!: number;
}

class BulkScoreEntryDto {
  @IsString() kpi_id!: string;
  @IsDateString() recorded_at!: string;
  @IsNumber() actual_value!: number;
}

class BulkScoreDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkScoreEntryDto) entries!: BulkScoreEntryDto[];
}

class NewKpiDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsNumber() target_value!: number; // the goal / green target
  @IsOptional() @IsNumber() green_threshold?: number | null; // meets-goal cutoff (defaults to target)
  @IsOptional() @IsNumber() red_threshold?: number | null; // below this is red (defaults to target)
  @IsOptional() @IsString() direction?: string; // 'higher_is_better' | 'lower_is_better'
  @IsOptional() @IsString() frequency?: string; // 'weekly' | 'monthly'
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
}

class UpdateKpiDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsNumber() target_value?: number | null;
  @IsOptional() @IsNumber() green_threshold?: number | null;
  @IsOptional() @IsNumber() red_threshold?: number | null;
  @IsOptional() @IsString() direction?: string | null;
  @IsOptional() @IsString() frequency?: string | null;
  @IsOptional() @IsString() unit?: string | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() owner_id?: string | null;
  @IsOptional() @IsNumber() sort_order?: number | null;
}

class ReorderDto {
  @IsArray() @IsString({ each: true }) order!: string[]; // kpi_ids in the desired display order
}

/**
 * Direction-aware Red/Yellow/Green. The yellow band is between the two
 * thresholds; when green == red it collapses to a binary GREEN/RED.
 */
function rag(direction: string, actual: number, green: number, red: number): string {
  if (direction === 'lower_is_better') {
    if (actual <= green) return 'GREEN';
    if (actual > red) return 'RED';
    return 'YELLOW';
  }
  // higher_is_better
  if (actual >= green) return 'GREEN';
  if (actual < red) return 'RED';
  return 'YELLOW';
}

/** Keep the legacy comparison_operator column in sync for exports/back-compat. */
function opFor(direction: string): string {
  return direction === 'lower_is_better' ? '<=' : '>=';
}

/**
 * Append one immutable data point, emit a scorecard-update event, and run the
 * auto-issue check. Returns the id of any auto-created Issue (or null). Must run
 * inside the caller's scoped transaction so the score insert and the auto-issue
 * insert are atomic.
 */
async function recordScore(
  sql: ScopedSql,
  user: CurrentUser,
  kpiId: string,
  recordedAt: string,
  actualValue: number,
): Promise<{ rag: string; auto_created_issue_id: string | null }> {
  const kpiRows = await sql`
    SELECT tenant_id, title, target_value, green_threshold, red_threshold, direction, owner_id
    FROM kpis WHERE id = ${kpiId}
  `;
  const kpi = kpiRows[0];
  if (!kpi) {
    throw new HttpException({ detail: 'KPI not found or not accessible' }, HttpStatus.NOT_FOUND);
  }

  await requirePermission(sql, user.user_id, String(kpi.tenant_id), 'create');

  await sql`
    INSERT INTO kpi_scores (tenant_id, kpi_id, recorded_at, actual_value)
    VALUES (${kpi.tenant_id as string}, ${kpiId}, ${recordedAt}, ${actualValue})
  `;

  const goal = Number(kpi.target_value);
  const green = kpi.green_threshold != null ? Number(kpi.green_threshold) : goal;
  const red = kpi.red_threshold != null ? Number(kpi.red_threshold) : goal;
  const direction = (kpi.direction as string | null) || 'higher_is_better';
  const currentRag = rag(direction, Number(actualValue), green, red);

  // Emit a scorecard-update event from day one — this audit_log feed is what the
  // Phase 2 OS Compliance Dashboard will consume.
  await auditLog(sql, user.user_id, 'scorecard.entry', {
    entityType: 'kpi',
    entityId: kpiId,
    tenantId: String(kpi.tenant_id),
    detail: `${kpi.title as string} = ${actualValue} → ${currentRag}`,
  });

  // Auto-create an Issue after 3 consecutive RED periods (Phase 2 preview).
  const recent = await sql`
    SELECT actual_value FROM kpi_scores WHERE kpi_id = ${kpiId} ORDER BY recorded_at DESC LIMIT 3
  `;
  const threeRed =
    recent.length === 3 && recent.every((r) => rag(direction, Number(r.actual_value), green, red) === 'RED');

  let autoIssue: string | null = null;
  if (threeRed) {
    const title = `${kpi.title as string} off-track 3 periods running`;
    const existingRows = await sql`
      SELECT 1 FROM issues WHERE tenant_id = ${kpi.tenant_id as string} AND title = ${title} AND status = 'open'
    `;
    if (!existingRows[0]) {
      const newRows = await sql`
        INSERT INTO issues (tenant_id, title, description, status, created_by)
        VALUES (${kpi.tenant_id as string}, ${title},
                ${'Auto-created: this metric has been red 3 periods in a row.'}, 'open', ${kpi.owner_id as string | null})
        RETURNING id
      `;
      autoIssue = String(newRows[0].id);
    }
  }
  return { rag: currentRag, auto_created_issue_id: autoIssue };
}

/** KPIs + weekly RAG history, append-only scores, the 3-RED auto-issue rule. Faithful port of scorecards.py. */
@Controller('scorecards')
@UseGuards(AuthGuard)
export class ScorecardsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async getScorecards(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('frequency') frequency?: string,
  ) {
    // The query below has NO tenant filter for isolation: if the caller passes a
    // tenant_id they can't access, RLS silently returns zero rows for it.
    const targetTenant = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      const kpis = await sql`
        SELECT k.id, k.title, k.description, k.frequency, k.direction,
               k.target_value, k.green_threshold, k.red_threshold, k.comparison_operator,
               k.unit, k.sort_order, u.name AS owner_name, k.owner_id, k.tenant_id
        FROM kpis k
        LEFT JOIN users u ON u.id = k.owner_id
        WHERE (${targetTenant}::uuid IS NULL OR k.tenant_id = ${targetTenant}::uuid)
          AND (${frequency ?? null}::text IS NULL OR k.frequency = ${frequency ?? null}::text)
        ORDER BY k.sort_order, k.title
      `;

      const result: Record<string, unknown>[] = [];
      for (const k of kpis) {
        const goal = Number(k.target_value);
        const green = k.green_threshold != null ? Number(k.green_threshold) : goal;
        const red = k.red_threshold != null ? Number(k.red_threshold) : goal;
        const direction = (k.direction as string | null) || 'higher_is_better';

        const scores = await sql`
          SELECT recorded_at, actual_value
          FROM kpi_scores
          WHERE kpi_id = ${k.id as string}
          ORDER BY recorded_at DESC
          LIMIT 13
        `;
        const weekly = scores.map((s) => {
          const val = Number(s.actual_value);
          const r = rag(direction, val, green, red);
          return {
            week_ending: new Date(s.recorded_at as string | Date).toISOString().slice(0, 10),
            actual_value: val,
            rag: r,
            // legacy field kept for older consumers: only GREEN counts as on-track
            status: r === 'GREEN' ? 'ON_TRACK' : 'OFF_TRACK',
          };
        });

        // most-recent-first from the query -> red streak counts from index 0
        let redStreak = 0;
        for (const w of weekly) {
          if (w.rag === 'RED') redStreak += 1;
          else break;
        }

        result.push({
          kpi_id: String(k.id),
          title: k.title,
          description: k.description,
          frequency: (k.frequency as string | null) || 'weekly',
          direction,
          owner: k.owner_name,
          owner_id: k.owner_id ? String(k.owner_id) : null,
          target_value: goal,
          green_threshold: green,
          red_threshold: red,
          comparison_operator: k.comparison_operator,
          unit: k.unit,
          sort_order: k.sort_order,
          tenant_id: String(k.tenant_id),
          weekly_history: [...weekly].reverse(), // chronological for charting
          current_rag: weekly.length ? weekly[0].rag : null,
          off_track_streak: redStreak,
        });
      }
      return result;
    });
  }

  @Post()
  @HttpCode(200)
  async createKpi(@Body() body: NewKpiDto, @Auth() user: CurrentUser) {
    // RLS's WITH CHECK refuses tenants you can't see.
    const green = body.green_threshold != null ? body.green_threshold : body.target_value;
    const red = body.red_threshold != null ? body.red_threshold : body.target_value;
    const direction = body.direction ?? 'higher_is_better';
    const frequency = body.frequency ?? 'weekly';
    const unit = body.unit ?? 'units';
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const nextOrderRows = await sql`
        SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM kpis WHERE tenant_id = ${body.tenant_id}
      `;
      const nextOrder = nextOrderRows[0].next;
      const rows = await sql`
        INSERT INTO kpis (tenant_id, title, description, owner_id, target_value,
                          green_threshold, red_threshold, direction, frequency,
                          comparison_operator, unit, sort_order)
        VALUES (${body.tenant_id}, ${body.title}, ${body.description ?? null}, ${body.owner_id || user.user_id},
                ${body.target_value}, ${green}, ${red}, ${direction}, ${frequency},
                ${opFor(direction)}, ${unit}, ${nextOrder})
        RETURNING id, title
      `;
      const row = rows[0];
      await auditLog(sql, user.user_id, 'scorecard.kpi_create', {
        entityType: 'kpi',
        entityId: String(row.id),
        tenantId: body.tenant_id,
        detail: body.title,
      });
      return row;
    });
  }

  @Patch(':kpiId')
  async updateKpi(@Param('kpiId') kpiId: string, @Body() body: UpdateKpiDto, @Auth() user: CurrentUser) {
    // COALESCE keeps unspecified fields unchanged. Editing a threshold does NOT
    // rewrite past history — kpi_scores is untouched; only how future/re-rendered
    // RAG is computed changes.
    const op = body.direction ? opFor(body.direction) : null;
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'kpis', kpiId, 'edit');
      const rows = await sql`
        UPDATE kpis SET
            title               = COALESCE(${body.title ?? null}, title),
            target_value        = COALESCE(${body.target_value ?? null}, target_value),
            green_threshold     = COALESCE(${body.green_threshold ?? null}, green_threshold),
            red_threshold       = COALESCE(${body.red_threshold ?? null}, red_threshold),
            direction           = COALESCE(${body.direction ?? null}, direction),
            frequency           = COALESCE(${body.frequency ?? null}, frequency),
            unit                = COALESCE(${body.unit ?? null}, unit),
            description         = COALESCE(${body.description ?? null}, description),
            owner_id            = COALESCE(${body.owner_id ?? null}, owner_id),
            sort_order          = COALESCE(${body.sort_order ?? null}, sort_order),
            comparison_operator = COALESCE(${op}, comparison_operator)
        WHERE id = ${kpiId}
        RETURNING id, title, tenant_id
      `;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'KPI not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await auditLog(sql, user.user_id, 'scorecard.kpi_edit', {
        entityType: 'kpi',
        entityId: kpiId,
        tenantId: String(row.tenant_id),
        detail: row.title as string,
      });
      return { id: String(row.id), title: row.title };
    });
  }

  @Post('reorder')
  @HttpCode(200)
  async reorderKpis(@Body() body: ReorderDto, @Auth() user: CurrentUser) {
    // Persist drag-to-reorder. RLS ensures a caller can only touch KPIs they can edit.
    return this.db.scoped(user.user_id, async (sql) => {
      for (let idx = 0; idx < body.order.length; idx++) {
        await sql`UPDATE kpis SET sort_order = ${idx} WHERE id = ${body.order[idx]}`;
      }
      return { reordered: body.order.length };
    });
  }

  @Delete(':kpiId')
  async deleteKpi(@Param('kpiId') kpiId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'kpis', kpiId, 'delete');
      const res = await sql`DELETE FROM kpis WHERE id = ${kpiId}`;
      return { deleted: commandTag(res) };
    });
  }

  @Post(':kpiId/scores')
  @HttpCode(200)
  async addScore(@Param('kpiId') kpiId: string, @Body() body: NewScoreDto, @Auth() user: CurrentUser) {
    // Append a new value. Never overwrites history — 'editing a goal shouldn't
    // rewrite the past', met with a plain append-only table.
    const res = await this.db.scoped(user.user_id, async (sql) => {
      return recordScore(sql, user, kpiId, body.recorded_at, body.actual_value);
    });
    return { inserted: true, ...res };
  }

  @Post('scores/bulk')
  @HttpCode(200)
  async addScoresBulk(@Body() body: BulkScoreDto, @Auth() user: CurrentUser) {
    // Bulk data entry — one round-trip to update this period across many KPIs.
    return this.db.scoped(user.user_id, async (sql) => {
      let inserted = 0;
      const autoIssues: string[] = [];
      for (const e of body.entries) {
        const res = await recordScore(sql, user, e.kpi_id, e.recorded_at, e.actual_value);
        inserted += 1;
        if (res.auto_created_issue_id) autoIssues.push(res.auto_created_issue_id);
      }
      return { inserted, auto_created_issue_ids: autoIssues };
    });
  }
}

@Module({ controllers: [ScorecardsController] })
export class ScorecardsModule {}
