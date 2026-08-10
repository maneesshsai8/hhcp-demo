import { Controller, Get, HttpException, HttpStatus, Module, Param, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { requirePermission } from '../common/permissions';
import { DatabaseService, ScopedSql } from '../database/database.service';
import * as engines from './report-engines';
import { Column, ScorecardData, SeatData } from './report-engines';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** name.lower().replace(' ', '-') — replace ALL spaces (Python replaces all). */
function slug(name: string): string {
  return name.toLowerCase().replace(/ /g, '-');
}

// Direction-aware Red/Yellow/Green — port of scorecards._rag.
function ragOf(direction: string, actual: number, green: number, red: number): string {
  if (direction === 'lower_is_better') {
    if (actual <= green) return 'GREEN';
    if (actual > red) return 'RED';
    return 'YELLOW';
  }
  if (actual >= green) return 'GREEN';
  if (actual < red) return 'RED';
  return 'YELLOW';
}

/** Port of scorecards.fetch_scorecards (only the fields the exports consume). */
async function fetchScorecards(sql: ScopedSql, targetTenant: string): Promise<ScorecardData[]> {
  const kpis = await sql`
    SELECT k.id, k.title, k.frequency, k.direction,
           k.target_value, k.green_threshold, k.red_threshold, k.comparison_operator,
           k.unit, k.sort_order, u.name AS owner_name
    FROM kpis k
    LEFT JOIN users u ON u.id = k.owner_id
    WHERE (${targetTenant}::uuid IS NULL OR k.tenant_id = ${targetTenant}::uuid)
    ORDER BY k.sort_order, k.title
  `;

  const result: ScorecardData[] = [];
  for (const k of kpis) {
    const goal = Number(k.target_value);
    const green = k.green_threshold != null ? Number(k.green_threshold) : goal;
    const red = k.red_threshold != null ? Number(k.red_threshold) : goal;
    const direction = (k.direction as string) || 'higher_is_better';

    const scores = await sql`
      SELECT recorded_at, actual_value
      FROM kpi_scores
      WHERE kpi_id = ${k.id as string}
      ORDER BY recorded_at DESC
      LIMIT 13
    `;
    const weekly = scores.map((s) => {
      const val = Number(s.actual_value);
      const rag = ragOf(direction, val, green, red);
      return {
        week_ending: new Date(s.recorded_at as string | Date).toISOString().slice(0, 10),
        actual_value: val,
        rag,
        status: rag === 'GREEN' ? 'ON_TRACK' : 'OFF_TRACK',
      };
    });
    weekly.reverse(); // chronological, matching fetch_scorecards

    result.push({
      title: k.title as string,
      owner: (k.owner_name as string | null) ?? null,
      comparison_operator: (k.comparison_operator as string | null) ?? null,
      target_value: goal,
      unit: (k.unit as string | null) ?? null,
      weekly_history: weekly,
    });
  }
  return result;
}

/** Port of seats.list_seats (only the fields the org-chart export consumes). */
async function listSeats(sql: ScopedSql, targetTenant: string): Promise<SeatData[]> {
  const rows = await sql`
    SELECT s.id, s.title, s.parent_seat_id, s.responsibilities, s.sort_order,
           s.holder_user_id, u.name AS holder_name,
           s.gwc_gets, s.gwc_wants, s.gwc_capacity,
           COALESCE(
             (SELECT json_agg(json_build_object('id', sh.user_id, 'name', hu.name) ORDER BY hu.name)
              FROM seat_holders sh JOIN users hu ON hu.id = sh.user_id
              WHERE sh.seat_id = s.id),
             '[]'::json) AS holders
    FROM seats s
    LEFT JOIN users u ON u.id = s.holder_user_id
    WHERE (${targetTenant}::uuid IS NULL OR s.tenant_id = ${targetTenant}::uuid)
    ORDER BY s.sort_order, s.created_at
  `;
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title as string,
    parent_seat_id: (r.parent_seat_id as string | null) ?? null,
    responsibilities: (r.responsibilities as string | null) ?? null,
    holder_name: (r.holder_name as string | null) ?? null,
    holders: (r.holders as { id: string; name: string }[]) ?? [],
    gwc_gets: (r.gwc_gets as boolean | null) ?? null,
    gwc_wants: (r.gwc_wants as boolean | null) ?? null,
    gwc_capacity: (r.gwc_capacity as boolean | null) ?? null,
  }));
}

// (kind) -> [sheet title, columns [[header, key]], list SELECT].
// SELECTs mirror backend/app/routers/reports.py::_MODULES (RLS supplies tenant
// scoping via scoped(); the WHERE tenant_id filter is kept identical to Python).
const MODULES: Record<string, { title: string; columns: Column[]; sql: (sql: ScopedSql, tenant: string) => Promise<Record<string, unknown>[]> }> = {
  rocks: {
    title: 'Rocks',
    columns: [
      ['Title', 'title'],
      ['Owner', 'owner_name'],
      ['Team', 'team_name'],
      ['Status', 'status'],
      ['Due', 'due_date'],
      ['Description', 'description'],
    ],
    sql: (sql, tenant) => sql`
      SELECT r.title, r.status, r.due_date, r.description,
             u.name AS owner_name, t.name AS team_name
      FROM rocks r
      LEFT JOIN users u ON u.id = r.owner_id
      LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.tenant_id = ${tenant}
      ORDER BY r.status, r.due_date
    ` as unknown as Promise<Record<string, unknown>[]>,
  },
  issues: {
    title: 'Issues',
    columns: [
      ['Title', 'title'],
      ['Status', 'status'],
      ['Priority', 'priority'],
      ['Team', 'team_name'],
      ['Raised by', 'created_by_name'],
      ['Description', 'description'],
    ],
    sql: (sql, tenant) => sql`
      SELECT i.title, i.status, i.priority, i.description,
             u.name AS created_by_name, t.name AS team_name
      FROM issues i
      LEFT JOIN users u ON u.id = i.created_by
      LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.tenant_id = ${tenant}
      ORDER BY i.status, i.created_at DESC
    ` as unknown as Promise<Record<string, unknown>[]>,
  },
  todos: {
    title: 'To-Dos',
    columns: [
      ['Title', 'title'],
      ['Owner', 'owner_name'],
      ['Team', 'team_name'],
      ['Status', 'status'],
      ['Due', 'due_date'],
      ['Description', 'description'],
    ],
    sql: (sql, tenant) => sql`
      SELECT t.title, t.status, t.due_date, t.description,
             u.name AS owner_name, tm.name AS team_name
      FROM todos t
      LEFT JOIN users u ON u.id = t.owner_id
      LEFT JOIN teams tm ON tm.id = t.team_id
      WHERE t.tenant_id = ${tenant}
      ORDER BY t.status, t.due_date NULLS LAST, t.created_at DESC
    ` as unknown as Promise<Record<string, unknown>[]>,
  },
};

/** Binary report downloads (xlsx/pdf/png). Faithful port of reports.py. */
@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly db: DatabaseService) {}

  private send(reply: FastifyReply, buffer: Buffer, mime: string, filename: string, engine?: string): void {
    reply.header('Content-Type', mime);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (engine !== undefined) reply.header('X-Report-Engine', engine);
    reply.send(buffer);
  }

  /** Port of reports._load — scorecard data + tenant name. */
  private async load(user: CurrentUser, tenantId?: string): Promise<{ name: string; data: ScorecardData[] }> {
    const target = tenantId || user.active_tenant_id;
    if (!target) {
      throw new HttpException({ detail: 'Pick a specific tenant to export' }, HttpStatus.BAD_REQUEST);
    }
    const { name, data } = await this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, String(target), 'view');
      const rows = await sql`SELECT name FROM organizations WHERE id = ${String(target)}`;
      const orgName = rows[0]?.name as string | undefined;
      const scorecards = orgName ? await fetchScorecards(sql, String(target)) : [];
      return { name: orgName, data: scorecards };
    });
    if (!name) {
      throw new HttpException({ detail: 'Tenant not found or not accessible' }, HttpStatus.NOT_FOUND);
    }
    return { name, data };
  }

  /** Port of reports._load_orgchart — seats + tenant name. */
  private async loadOrgchart(user: CurrentUser, tenantId?: string): Promise<{ name: string; seats: SeatData[] }> {
    const target = tenantId || user.active_tenant_id;
    if (!target) {
      throw new HttpException({ detail: 'Pick a specific tenant to export' }, HttpStatus.BAD_REQUEST);
    }
    const { name, seats } = await this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, String(target), 'view');
      const rows = await sql`SELECT name FROM organizations WHERE id = ${String(target)}`;
      const orgName = rows[0]?.name as string | undefined;
      const seatRows = orgName ? await listSeats(sql, String(target)) : [];
      return { name: orgName, seats: seatRows };
    });
    if (!name) {
      throw new HttpException({ detail: 'Tenant not found or not accessible' }, HttpStatus.NOT_FOUND);
    }
    return { name, seats };
  }

  /** Port of reports._load_list — generic module rows + tenant name. */
  private async loadList(
    user: CurrentUser,
    tenantId: string | undefined,
    kind: string,
  ): Promise<{ name: string; title: string; columns: Column[]; rows: Record<string, unknown>[] }> {
    const mod = MODULES[kind];
    if (!mod) {
      throw new HttpException({ detail: 'Unknown report' }, HttpStatus.NOT_FOUND);
    }
    const target = tenantId || user.active_tenant_id;
    if (!target) {
      throw new HttpException({ detail: 'Pick a specific tenant to export' }, HttpStatus.BAD_REQUEST);
    }
    const { name, rows } = await this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, String(target), 'view');
      const nameRows = await sql`SELECT name FROM organizations WHERE id = ${String(target)}`;
      const orgName = nameRows[0]?.name as string | undefined;
      const dataRows = orgName ? await mod.sql(sql, String(target)) : [];
      return { name: orgName, rows: dataRows };
    });
    if (!name) {
      throw new HttpException({ detail: 'Tenant not found or not accessible' }, HttpStatus.NOT_FOUND);
    }
    return { name, title: mod.title, columns: mod.columns, rows };
  }

  @Get('orgchart.pdf')
  async orgchartPdf(@Auth() user: CurrentUser, @Res() reply: FastifyReply, @Query('tenant_id') tenantId?: string) {
    const { name, seats } = await this.loadOrgchart(user, tenantId);
    const { buffer, engine } = await engines.buildOrgchartPdf(name, seats);
    this.send(reply, buffer, 'application/pdf', `org-chart-${slug(name)}.pdf`, engine);
  }

  @Get('orgchart.png')
  async orgchartPng(@Auth() user: CurrentUser, @Res() reply: FastifyReply, @Query('tenant_id') tenantId?: string) {
    const { name, seats } = await this.loadOrgchart(user, tenantId);
    const buffer = await engines.buildOrgchartPng(name, seats);
    this.send(reply, buffer, 'image/png', `org-chart-${slug(name)}.png`);
  }

  @Get('scorecard.xlsx')
  async scorecardXlsx(@Auth() user: CurrentUser, @Res() reply: FastifyReply, @Query('tenant_id') tenantId?: string) {
    const { name, data } = await this.load(user, tenantId);
    const buffer = await engines.buildScorecardXlsx(name, data);
    this.send(reply, buffer, XLSX_MIME, `scorecard-${slug(name)}.xlsx`);
  }

  @Get('scorecard.pdf')
  async scorecardPdf(@Auth() user: CurrentUser, @Res() reply: FastifyReply, @Query('tenant_id') tenantId?: string) {
    const { name, data } = await this.load(user, tenantId);
    const { buffer, engine } = await engines.buildScorecardPdf(name, data);
    this.send(reply, buffer, 'application/pdf', `scorecard-${slug(name)}.pdf`, engine);
  }

  @Get(':kind.xlsx')
  async listXlsx(
    @Param('kind') kind: string,
    @Auth() user: CurrentUser,
    @Res() reply: FastifyReply,
    @Query('tenant_id') tenantId?: string,
  ) {
    const { name, title, columns, rows } = await this.loadList(user, tenantId, kind);
    const buffer = await engines.buildTableXlsx(title, `${title} — ${name}`, columns, rows);
    this.send(reply, buffer, XLSX_MIME, `${kind}-${slug(name)}.xlsx`);
  }

  @Get(':kind.pdf')
  async listPdf(
    @Param('kind') kind: string,
    @Auth() user: CurrentUser,
    @Res() reply: FastifyReply,
    @Query('tenant_id') tenantId?: string,
  ) {
    const { name, title, columns, rows } = await this.loadList(user, tenantId, kind);
    const { buffer, engine } = await engines.buildTablePdf(`${title} — ${name}`, columns, rows);
    this.send(reply, buffer, 'application/pdf', `${kind}-${slug(name)}.pdf`, engine);
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
