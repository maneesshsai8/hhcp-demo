import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { IsArray, IsNumber, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { agenda as builtinAgenda, AGENDAS, totalMinutes } from '../common/agendas';
import { auditLog } from '../common/audit';
import { commandTag } from '../common/fund-access';
import * as idempotency from '../common/idempotency';
import { buildSummary } from '../common/meeting-summary';
import { emit } from '../common/outbox';
import { effectiveRole, requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService, ScopedSql } from '../database/database.service';

// ---------------------------------------------------------------------------
// DTOs (faithful ports of the Pydantic request models in meetings.py)
// ---------------------------------------------------------------------------
class NewMeetingDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() scheduled_at?: string | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsString() calendar_provider?: string | null; // 'google' | 'microsoft'
}

class UpdateMeetingDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() scheduled_at?: string | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsNumber() expected_version?: number | null; // optimistic lock
}

class LifecycleDto {
  @IsOptional() @IsNumber() expected_version?: number | null;
  @IsOptional() @IsString() reason?: string | null;
}

class SectionDto {
  @IsNumber() index!: number;
  @IsOptional() @IsNumber() expected_version?: number | null;
}

class RatingDto {
  @IsNumber() rating!: number; // 1..10, validated in the handler for a clean 422
  @IsOptional() @IsString() feedback?: string | null;
}

class StartMeetingDto {
  @IsString() tenant_id!: string;
  @IsString() agenda_key!: string;
  @IsOptional() @IsString() team_id?: string | null;
}

class FinishMeetingDto {
  @IsOptional() @IsNumber() rating?: number | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) attendee_ids?: string[] | null;
}

class TemplateDto {
  @IsString() tenant_id!: string;
  @IsString() name!: string;
  @IsArray() sections!: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Meeting-level state machine. A transition is rejected (409) unless the
// meeting's current status is in the allowed source set for that action.
// ---------------------------------------------------------------------------
const ALLOWED_FROM: Record<string, Set<string>> = {
  start: new Set(['draft', 'scheduled']),
  pause: new Set(['in_progress']),
  resume: new Set(['paused']),
  complete: new Set(['in_progress', 'paused']),
  cancel: new Set(['draft', 'scheduled', 'in_progress', 'paused']),
};

function assertTransition(action: string, status: string): void {
  if (!ALLOWED_FROM[action].has(status)) {
    throw new HttpException(
      { detail: `Cannot ${action} a meeting in state '${status}'` },
      HttpStatus.CONFLICT,
    );
  }
}

// Per-item (agenda segment) state machine.
const ITEM_ALLOWED_FROM: Record<string, Set<string>> = {
  start: new Set(['PENDING', 'SKIPPED']),
  pause: new Set(['IN_PROGRESS']),
  resume: new Set(['PAUSED']),
  complete: new Set(['IN_PROGRESS', 'PAUSED']),
  skip: new Set(['PENDING', 'IN_PROGRESS', 'PAUSED']),
};
const ITEM_TARGET: Record<string, string> = {
  start: 'IN_PROGRESS',
  pause: 'PAUSED',
  resume: 'IN_PROGRESS',
  complete: 'COMPLETED',
  skip: 'SKIPPED',
};

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  return v ? new Date(v as string | Date).toISOString() : null;
}

/** postgres.js auto-parses jsonb; tolerate string or already-parsed values. */
function parseJsonb(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'string') return JSON.parse(v);
  return v;
}

function durationSeconds(r: Row): number | null {
  if (r.started_at && r.ended_at) {
    return Math.floor(
      (new Date(r.ended_at as string | Date).getTime() - new Date(r.started_at as string | Date).getTime()) / 1000,
    );
  }
  return null;
}

function checkVersion(m: Row, expected: number | null | undefined): void {
  if (expected != null && (m.version as number) !== expected) {
    throw new HttpException(
      { detail: `Stale meeting version (have ${m.version}, sent ${expected})` },
      HttpStatus.CONFLICT,
    );
  }
}

async function loadState(sql: ScopedSql, meetingId: string): Promise<Row> {
  const rows = await sql`
    SELECT status, title, tenant_id, version, started_at, paused_at, accumulated_paused_seconds
    FROM meetings WHERE id = ${meetingId}
  `;
  if (!rows[0]) {
    throw new HttpException({ detail: 'Meeting not found or not accessible' }, HttpStatus.NOT_FOUND);
  }
  return rows[0] as Row;
}

function itemDto(r: Row): Row {
  return {
    id: String(r.id),
    segment_type: r.segment_type,
    title: r.title,
    description: r.description,
    duration_seconds: r.duration_seconds,
    display_order: r.display_order,
    status: r.status,
    started_at: iso(r.started_at),
    paused_at: iso(r.paused_at),
    completed_at: iso(r.completed_at),
    accumulated_paused_seconds: r.accumulated_paused_seconds,
    notes: r.notes,
    version: r.version,
  };
}

/** Copy an agenda snapshot into meeting_agenda_items rows. Idempotent. */
async function materializeAgendaItems(
  sql: ScopedSql,
  meetingId: string,
  tenantId: string,
  sections: Array<Record<string, unknown>>,
): Promise<void> {
  const existing = await sql`SELECT count(*) AS c FROM meeting_agenda_items WHERE meeting_id = ${meetingId}`;
  if (Number(existing[0]?.c) > 0) return;
  const list = sections || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    await sql`
      INSERT INTO meeting_agenda_items
          (meeting_id, tenant_id, segment_type, title, description, duration_seconds, display_order, config)
      VALUES (
        ${meetingId}, ${tenantId}, ${(s.kind as string) ?? 'text'},
        ${(s.label as string) ?? `Segment ${i + 1}`}, ${(s.prompt as string) ?? null},
        ${Math.trunc(Number(s.minutes ?? 5)) * 60}, ${i}, ${sql.json({ key: s.key ?? null } as never)}
      )
    `;
  }
}

async function canEdit(sql: ScopedSql, userId: string, tenantId: string): Promise<boolean> {
  try {
    await requirePermission(sql, userId, String(tenantId), 'edit');
    return true;
  } catch {
    return false;
  }
}

/**
 * The Meetings module — Weekly (L10) meetings: state machine, per-segment timers,
 * optimistic locking, idempotency, transactional outbox, ratings, templates,
 * agenda items and calendar links. Faithful 1:1 port of meetings.py.
 */
@Controller('meetings')
@UseGuards(AuthGuard)
export class MeetingsController {
  constructor(private readonly db: DatabaseService) {}

  // ---- static GET routes (declared before parametric /:meetingId) ----------
  @Get('agendas')
  listAgendas() {
    return Object.values(AGENDAS).map((a) => ({
      key: a.key,
      name: a.name,
      type: a.type,
      total_minutes: totalMinutes(a),
      sections: a.sections,
    }));
  }

  @Get('ratings/trend')
  async ratingsTrend(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('team_id') teamId?: string,
    @Query('limit') limit?: string,
  ) {
    const target = tenantId || user.active_tenant_id || null;
    const lim = limit != null ? parseInt(limit, 10) : 20;
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT id, title, rating, COALESCE(ended_at, scheduled_at, created_at) AS at
        FROM meetings
        WHERE rating IS NOT NULL
          AND (${target}::uuid IS NULL OR tenant_id = ${target}::uuid)
          AND (${teamId ?? null}::uuid IS NULL OR team_id = ${teamId ?? null}::uuid)
        ORDER BY COALESCE(ended_at, scheduled_at, created_at) DESC
        LIMIT ${lim}
      `;
    });
    const pts = [...rows].reverse().map((r) => ({
      id: String(r.id),
      title: r.title,
      rating: Number(r.rating),
      at: iso(r.at),
    }));
    const avg = pts.length ? Math.round((pts.reduce((s, p) => s + p.rating, 0) / pts.length) * 10) / 10 : null;
    return { points: pts, average: avg, count: pts.length };
  }

  @Get('templates/list')
  async listTemplates(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT id, tenant_id, name, sections, created_by FROM agenda_templates
        WHERE (${target}::uuid IS NULL OR tenant_id = ${target}::uuid) ORDER BY name
      `;
    });
    return rows.map((r) => ({
      ...r,
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      sections: parseJsonb(r.sections),
    }));
  }

  @Get()
  async listMeetings(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('q') q?: string,
    @Query('team_id') teamId?: string,
    @Query('since') since?: string,
  ) {
    const target = tenantId || user.active_tenant_id || null;
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT m.id, m.title, m.scheduled_at, m.status, m.notes, m.tenant_id,
               m.agenda_key, m.started_at, m.ended_at, m.rating,
               u.name AS created_by_name
        FROM meetings m
        LEFT JOIN users u ON u.id = m.created_by
        WHERE (${target}::uuid IS NULL OR m.tenant_id = ${target}::uuid)
          AND (${teamId ?? null}::uuid IS NULL OR m.team_id = ${teamId ?? null}::uuid)
          AND (${since ?? null}::timestamptz IS NULL OR COALESCE(m.ended_at, m.scheduled_at, m.created_at) >= ${since ?? null}::timestamptz)
          AND (${q ?? null}::text IS NULL OR m.title ILIKE '%'||${q ?? null}||'%' OR m.notes ILIKE '%'||${q ?? null}||'%' OR m.summary::text ILIKE '%'||${q ?? null}||'%')
        ORDER BY COALESCE(m.ended_at, m.started_at, m.scheduled_at, m.created_at) DESC
      `;
    });
    return rows.map((r) => ({
      id: String(r.id),
      title: r.title,
      scheduled_at: iso(r.scheduled_at),
      status: r.status,
      notes: r.notes,
      tenant_id: String(r.tenant_id),
      created_by_name: r.created_by_name,
      agenda_key: r.agenda_key,
      started_at: iso(r.started_at),
      ended_at: iso(r.ended_at),
      rating: r.rating != null ? Number(r.rating) : null,
      duration_seconds: durationSeconds(r as Row),
    }));
  }

  // ---- static POST routes (declared before parametric /:meetingId/...) -----
  @Post('start')
  @HttpCode(200)
  async startMeeting(@Body() body: StartMeetingDto, @Auth() user: CurrentUser) {
    // resolve built-in agenda first (matches Python ordering)
    const builtin = builtinAgenda(body.agenda_key);
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      let a: { key: string; name: string; sections: Array<Record<string, unknown>> };
      if (builtin) {
        a = { key: builtin.key, name: builtin.name, sections: builtin.sections as unknown as Array<Record<string, unknown>> };
      } else {
        const t = await sql`SELECT name, sections FROM agenda_templates WHERE id = ${body.agenda_key}`;
        if (!t[0]) {
          throw new HttpException({ detail: 'Unknown agenda' }, HttpStatus.NOT_FOUND);
        }
        a = {
          key: body.agenda_key,
          name: t[0].name as string,
          sections: (parseJsonb(t[0].sections) as Array<Record<string, unknown>>) ?? [],
        };
      }
      const rows = await sql`
        INSERT INTO meetings (tenant_id, title, status, agenda_key, sections, started_at, created_by, team_id)
        VALUES (${body.tenant_id}, ${a.name}, 'in_progress', ${a.key}, ${sql.json(a.sections as never)}, now(), ${user.user_id}, ${body.team_id ?? null})
        RETURNING id
      `;
      const meetingId = String(rows[0].id);
      await materializeAgendaItems(sql, meetingId, body.tenant_id, a.sections);
      await emit(sql, 'meeting.started', {
        aggregateId: meetingId,
        tenantId: body.tenant_id,
        payload: { meetingId, tenantId: body.tenant_id },
      });
      return { id: meetingId, agenda_key: a.key };
    });
  }

  @Post('templates')
  @HttpCode(200)
  async createTemplate(@Body() body: TemplateDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const rows = await sql`
        INSERT INTO agenda_templates (tenant_id, name, sections, created_by)
        VALUES (${body.tenant_id}, ${body.name}, ${sql.json(body.sections as never)}, ${user.user_id})
        RETURNING id
      `;
      return { id: String(rows[0].id) };
    });
  }

  @Post()
  @HttpCode(200)
  async createMeeting(@Body() body: NewMeetingDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const rows = await sql`
        INSERT INTO meetings (tenant_id, title, scheduled_at, notes, created_by)
        VALUES (${body.tenant_id}, ${body.title}, ${body.scheduled_at ?? null}, ${body.notes ?? null}, ${user.user_id})
        RETURNING id, title, status, scheduled_at, tenant_id
      `;
      const row = rows[0] as Row;
      const meetingId = String(row.id);
      // optional async calendar sync — never blocks / rolls back the meeting
      if (body.calendar_provider === 'google' || body.calendar_provider === 'microsoft') {
        await sql`
          INSERT INTO meeting_calendar_links (meeting_id, tenant_id, provider, sync_status)
          VALUES (${meetingId}, ${body.tenant_id}, ${body.calendar_provider}, 'pending')
          ON CONFLICT (meeting_id, provider) DO NOTHING
        `;
        await emit(sql, 'calendar.create', {
          aggregateId: meetingId,
          tenantId: body.tenant_id,
          payload: {
            meetingId,
            tenantId: body.tenant_id,
            provider: body.calendar_provider,
            actorId: String(user.user_id),
            title: body.title,
            scheduledAt: body.scheduled_at ?? null,
          },
        });
      }
      return {
        id: meetingId,
        title: row.title,
        status: row.status,
        scheduled_at: iso(row.scheduled_at),
        tenant_id: String(row.tenant_id),
      };
    });
  }

  // ---- parametric GET routes ----------------------------------------------
  @Get(':meetingId/calendar')
  async calendarStatus(@Param('meetingId') meetingId: string, @Auth() user: CurrentUser) {
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT provider, sync_status, external_event_id, last_synced_at, last_error
        FROM meeting_calendar_links WHERE meeting_id = ${meetingId} ORDER BY provider
      `;
    });
    return {
      links: rows.map((r) => ({
        provider: r.provider,
        sync_status: r.sync_status,
        external_event_id: r.external_event_id,
        last_synced_at: iso(r.last_synced_at),
        last_error: r.last_error,
      })),
    };
  }

  @Get(':meetingId/live-state')
  async liveState(@Param('meetingId') meetingId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const mRows = await sql`
        SELECT id, title, status, tenant_id, version, agenda_version, current_section_index,
               sections, started_at, paused_at, accumulated_paused_seconds, rating
        FROM meetings WHERE id = ${meetingId}
      `;
      const m = mRows[0] as Row | undefined;
      if (!m) {
        throw new HttpException({ detail: 'Meeting not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      const nowRows = await sql`SELECT now() AS now`;
      const serverNow = nowRows[0].now;
      const att = await sql`
        SELECT u.id, u.name FROM meeting_attendance a JOIN users u ON u.id = a.user_id
        WHERE a.meeting_id = ${meetingId} ORDER BY u.name
      `;
      let recentIssues: Row[] = [];
      let recentTodos: Row[] = [];
      if (m.started_at) {
        recentIssues = (await sql`
          SELECT id, title, status FROM issues WHERE tenant_id = ${m.tenant_id as string} AND created_at >= ${m.started_at as Date}
          ORDER BY created_at DESC LIMIT 20
        `) as unknown as Row[];
        recentTodos = (await sql`
          SELECT id, title, status FROM todos WHERE tenant_id = ${m.tenant_id as string} AND created_at >= ${m.started_at as Date}
          ORDER BY created_at DESC LIMIT 20
        `) as unknown as Row[];
      }
      const items = await sql`
        SELECT id, segment_type, title, description, duration_seconds, display_order, status,
               started_at, paused_at, completed_at, accumulated_paused_seconds, notes, version
        FROM meeting_agenda_items WHERE meeting_id = ${meetingId} ORDER BY display_order
      `;
      const editable = await canEdit(sql, user.user_id, m.tenant_id as string);
      const role = await effectiveRole(sql, user.user_id, String(m.tenant_id));
      const sections = parseJsonb(m.sections) ?? [];
      return {
        id: String(m.id),
        title: m.title,
        status: m.status,
        version: m.version,
        agenda_version: m.agenda_version,
        current_section_index: m.current_section_index,
        timer: {
          started_at: iso(m.started_at),
          paused_at: iso(m.paused_at),
          accumulated_paused_seconds: m.accumulated_paused_seconds,
          server_now: iso(serverNow),
        },
        sections,
        agenda_items: items.map((r) => itemDto(r as Row)),
        attendance: att.map((r) => ({ id: String(r.id), name: r.name })),
        recent_issues: recentIssues.map((r) => ({ id: String(r.id), title: r.title, status: r.status })),
        recent_todos: recentTodos.map((r) => ({ id: String(r.id), title: r.title, status: r.status })),
        permissions: { role, can_edit: editable },
      };
    });
  }

  @Get(':meetingId/ratings')
  async listRatings(@Param('meetingId') meetingId: string, @Auth() user: CurrentUser) {
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT r.rating, r.feedback, r.submitted_at, u.name, r.user_id
        FROM meeting_ratings r JOIN users u ON u.id = r.user_id
        WHERE r.meeting_id = ${meetingId} ORDER BY r.submitted_at
      `;
    });
    const ratings = rows.map((r) => ({
      user_id: String(r.user_id),
      name: r.name,
      rating: Number(r.rating),
      feedback: r.feedback,
      submitted_at: iso(r.submitted_at),
    }));
    const avg = ratings.length
      ? Math.round((ratings.reduce((s, x) => s + x.rating, 0) / ratings.length) * 10) / 10
      : null;
    return { ratings, average: avg, count: ratings.length };
  }

  @Get(':meetingId')
  async getMeeting(@Param('meetingId') meetingId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`
        SELECT m.id, m.title, m.status, m.notes, m.tenant_id, m.agenda_key,
               m.sections, m.started_at, m.ended_at, m.rating, m.team_id, m.summary,
               u.name AS facilitator_name, t.name AS team_name
        FROM meetings m
        LEFT JOIN users u ON u.id = m.created_by
        LEFT JOIN teams t ON t.id = m.team_id
        WHERE m.id = ${meetingId}
      `;
      const row = rows[0] as Row | undefined;
      if (!row) {
        throw new HttpException({ detail: 'Meeting not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      const att = await sql`
        SELECT u.id, u.name FROM meeting_attendance a JOIN users u ON u.id = a.user_id
        WHERE a.meeting_id = ${meetingId} ORDER BY u.name
      `;
      let roster: readonly Row[];
      if (row.team_id) {
        roster = (await sql`
          SELECT u.id, u.name FROM team_members tmb JOIN users u ON u.id = tmb.user_id WHERE tmb.team_id = ${row.team_id as string}
        `) as unknown as Row[];
      } else {
        roster = (await sql`
          SELECT DISTINCT u.id, u.name FROM users u
          WHERE u.id = current_setting('app.current_user_id', true)::uuid
             OR u.id IN (SELECT user_id FROM team_members)
             OR u.id IN (SELECT user_id FROM tenant_memberships)
          ORDER BY u.name
        `) as unknown as Row[];
      }
      return {
        id: String(row.id),
        title: row.title,
        status: row.status,
        notes: row.notes,
        tenant_id: String(row.tenant_id),
        agenda_key: row.agenda_key,
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
        rating: row.rating != null ? Number(row.rating) : null,
        team_id: row.team_id ? String(row.team_id) : null,
        summary: parseJsonb(row.summary),
        facilitator_name: row.facilitator_name,
        team_name: row.team_name,
        attendance: att.map((r) => ({ id: String(r.id), name: r.name })),
        roster: roster.map((r) => ({ id: String(r.id), name: r.name })),
        sections: parseJsonb(row.sections) ?? [],
        duration_seconds: durationSeconds(row),
      };
    });
  }

  // ---- lifecycle / state-machine POSTs ------------------------------------
  @Post(':meetingId/start')
  @HttpCode(200)
  async startLifecycle(
    @Param('meetingId') meetingId: string,
    @Body() body: LifecycleDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Auth() user: CurrentUser,
  ) {
    const keyBody = JSON.stringify(body ?? {});
    return this.db.scoped(user.user_id, async (sql) => {
      const prior = await idempotency.lookup(sql, user.user_id, 'meeting.start', idempotencyKey, keyBody);
      if (prior !== null) return prior;
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const m = await loadState(sql, meetingId);
      assertTransition('start', m.status as string);
      checkVersion(m, body?.expected_version ?? null);
      const rows = await sql`
        UPDATE meetings SET status = 'in_progress',
            started_at = COALESCE(started_at, now()), version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING version, started_at
      `;
      await emit(sql, 'meeting.started', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId, tenantId: String(tenantId) },
      });
      const result = {
        id: meetingId,
        status: 'in_progress',
        version: rows[0].version,
        started_at: iso(rows[0].started_at),
      };
      await idempotency.save(sql, user.user_id, 'meeting.start', idempotencyKey, keyBody, {
        tenantId: String(tenantId),
        response: result,
      });
      return result;
    });
  }

  @Post(':meetingId/pause')
  @HttpCode(200)
  async pauseMeeting(@Param('meetingId') meetingId: string, @Body() body: LifecycleDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const m = await loadState(sql, meetingId);
      assertTransition('pause', m.status as string);
      checkVersion(m, body?.expected_version ?? null);
      const rows = await sql`
        UPDATE meetings SET status = 'paused', paused_at = now(), version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING version
      `;
      await emit(sql, 'meeting.paused', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId },
      });
      return { id: meetingId, status: 'paused', version: rows[0].version };
    });
  }

  @Post(':meetingId/resume')
  @HttpCode(200)
  async resumeMeeting(@Param('meetingId') meetingId: string, @Body() body: LifecycleDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const m = await loadState(sql, meetingId);
      assertTransition('resume', m.status as string);
      checkVersion(m, body?.expected_version ?? null);
      const rows = await sql`
        UPDATE meetings SET status = 'in_progress',
            accumulated_paused_seconds = accumulated_paused_seconds
                + CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END,
            paused_at = NULL, version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING version, accumulated_paused_seconds
      `;
      await emit(sql, 'meeting.resumed', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId },
      });
      return {
        id: meetingId,
        status: 'in_progress',
        version: rows[0].version,
        accumulated_paused_seconds: rows[0].accumulated_paused_seconds,
      };
    });
  }

  @Post(':meetingId/cancel')
  @HttpCode(200)
  async cancelMeeting(@Param('meetingId') meetingId: string, @Body() body: LifecycleDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const m = await loadState(sql, meetingId);
      assertTransition('cancel', m.status as string);
      checkVersion(m, body?.expected_version ?? null);
      const rows = await sql`
        UPDATE meetings SET status = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING version
      `;
      await emit(sql, 'meeting.cancelled', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId, reason: body?.reason ?? null },
      });
      await auditLog(sql, user.user_id, 'meeting.cancelled', {
        entityType: 'meeting',
        entityId: meetingId,
        tenantId: String(tenantId),
        detail: m.title as string,
      });
      return { id: meetingId, status: 'cancelled', version: rows[0].version };
    });
  }

  @Post(':meetingId/current-section')
  @HttpCode(200)
  async setCurrentSection(
    @Param('meetingId') meetingId: string,
    @Body() body: SectionDto,
    @Auth() user: CurrentUser,
  ) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const m = await loadState(sql, meetingId);
      checkVersion(m, body.expected_version ?? null);
      const rows = await sql`
        UPDATE meetings SET current_section_index = ${body.index}, version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING version
      `;
      await emit(sql, 'segment.changed', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId, index: body.index, version: rows[0].version },
      });
      return { id: meetingId, current_section_index: body.index, version: rows[0].version };
    });
  }

  @Post(':meetingId/complete')
  @HttpCode(200)
  async completeMeeting(
    @Param('meetingId') meetingId: string,
    @Body() body: FinishMeetingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Auth() user: CurrentUser,
  ) {
    return this.completeEndpoint(meetingId, body, idempotencyKey, user);
  }

  @Post(':meetingId/finish')
  @HttpCode(200)
  async finishMeeting(
    @Param('meetingId') meetingId: string,
    @Body() body: FinishMeetingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Auth() user: CurrentUser,
  ) {
    return this.completeEndpoint(meetingId, body, idempotencyKey, user);
  }

  private async completeEndpoint(
    meetingId: string,
    body: FinishMeetingDto,
    idempotencyKey: string | undefined,
    user: CurrentUser,
  ) {
    const keyBody = JSON.stringify(body ?? {});
    return this.db.scoped(user.user_id, async (sql) => {
      const prior = await idempotency.lookup(sql, user.user_id, 'meeting.complete', idempotencyKey, keyBody);
      if (prior !== null) return prior;
      const result = await this.completeCore(sql, user.user_id, meetingId, {
        rating: body.rating ?? null,
        notes: body.notes ?? null,
        attendeeIds: body.attendee_ids ?? null,
      });
      await idempotency.save(sql, user.user_id, 'meeting.complete', idempotencyKey, keyBody, {
        status: 200,
        response: result,
      });
      return result;
    });
  }

  private async completeCore(
    sql: ScopedSql,
    userId: string,
    meetingId: string,
    opts: { rating: number | null; notes: string | null; attendeeIds: string[] | null },
  ) {
    const tenantId = await requireRowPermission(sql, userId, 'meetings', meetingId, 'edit');
    const m = await loadState(sql, meetingId);
    assertTransition('complete', m.status as string);

    if (opts.attendeeIds && opts.attendeeIds.length) {
      await sql`DELETE FROM meeting_attendance WHERE meeting_id = ${meetingId}`;
      for (const uid of opts.attendeeIds) {
        if (uid) {
          await sql`
            INSERT INTO meeting_attendance (meeting_id, user_id, tenant_id)
            VALUES (${meetingId}, ${uid}, ${String(tenantId)}) ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    // fold any open pause into accumulated time, then close
    await sql`
      UPDATE meetings SET
          status = 'completed', ended_at = now(),
          accumulated_paused_seconds = accumulated_paused_seconds
              + CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END,
          paused_at = NULL,
          rating = COALESCE(${opts.rating}, rating), notes = COALESCE(${opts.notes}, notes),
          version = version + 1, updated_at = now()
      WHERE id = ${meetingId}
    `;

    const summary = await buildSummary(sql, meetingId);
    await sql`UPDATE meetings SET summary = ${sql.json(summary as never)} WHERE id = ${meetingId}`;

    const payload = {
      meetingId,
      tenantId: String(tenantId),
      title: m.title,
      actorId: String(userId), // worker scopes its RLS reads to the completer
      durationSeconds: summary.duration_seconds,
      presentCount: summary.attendance,
      issuesCreated: summary.issues_raised.length,
      issuesResolved: summary.issues_solved,
      todosCreated: summary.todos_created.length,
      averageRating: summary.rating,
    };
    await emit(sql, 'meeting.completed', { aggregateId: meetingId, tenantId: String(tenantId), payload });
    await auditLog(sql, userId, 'meeting.completed', {
      entityType: 'meeting',
      entityId: meetingId,
      tenantId: String(tenantId),
      detail: `${m.title as string} · rated ${opts.rating != null ? opts.rating : '—'}`,
    });
    return { id: meetingId, duration_seconds: summary.duration_seconds, summary };
  }

  @Post(':meetingId/ratings')
  @HttpCode(200)
  async submitRating(@Param('meetingId') meetingId: string, @Body() body: RatingDto, @Auth() user: CurrentUser) {
    if (!(body.rating >= 1 && body.rating <= 10)) {
      throw new HttpException({ detail: 'rating must be between 1 and 10' }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return this.db.scoped(user.user_id, async (sql) => {
      const tRows = await sql`SELECT tenant_id FROM meetings WHERE id = ${meetingId}`;
      const tenantId = tRows[0]?.tenant_id as string | undefined;
      if (tenantId == null) {
        throw new HttpException({ detail: 'Meeting not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      await sql`
        INSERT INTO meeting_ratings (meeting_id, user_id, tenant_id, rating, feedback)
        VALUES (${meetingId}, ${user.user_id}, ${tenantId}, ${body.rating}, ${body.feedback ?? null})
        ON CONFLICT (meeting_id, user_id)
        DO UPDATE SET rating = EXCLUDED.rating, feedback = EXCLUDED.feedback, updated_at = now()
      `;
      const agg = await sql`
        SELECT round(avg(rating),1) AS avg, count(*) AS n FROM meeting_ratings WHERE meeting_id = ${meetingId}
      `;
      await sql`UPDATE meetings SET rating = ${agg[0].avg as string | null}, updated_at = now() WHERE id = ${meetingId}`;
      return {
        meeting_id: meetingId,
        average: agg[0].avg != null ? Number(agg[0].avg) : null,
        count: agg[0].n,
        my_rating: body.rating,
      };
    });
  }

  // ---- agenda-items: reorder + per-item state machine ----------------------
  @Post(':meetingId/agenda-items/reorder')
  @HttpCode(200)
  async reorderAgendaItems(
    @Param('meetingId') meetingId: string,
    @Body() body: Record<string, unknown>,
    @Auth() user: CurrentUser,
  ) {
    const ordered = (body?.orderedAgendaItemIds as string[]) || [];
    const expected = (body?.version as number | null | undefined) ?? null;
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      const mRows = await sql`SELECT agenda_version FROM meetings WHERE id = ${meetingId}`;
      const m = mRows[0] as Row | undefined;
      if (!m) {
        throw new HttpException({ detail: 'Meeting not found' }, HttpStatus.NOT_FOUND);
      }
      if (expected != null && (m.agenda_version as number) !== expected) {
        throw new HttpException(
          { detail: `Stale agenda version (have ${m.agenda_version}, sent ${expected})` },
          HttpStatus.CONFLICT,
        );
      }
      const idRows = await sql`SELECT id FROM meeting_agenda_items WHERE meeting_id = ${meetingId}`;
      const idSet = new Set(idRows.map((r) => String(r.id)));
      const orderedSet = new Set(ordered);
      const sameSet = orderedSet.size === idSet.size && [...orderedSet].every((x) => idSet.has(x));
      if (!sameSet || ordered.length !== idSet.size) {
        throw new HttpException(
          { detail: "orderedAgendaItemIds must be exactly the meeting's agenda items" },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      // push to high temp orders first to dodge the unique constraint mid-shuffle, then final
      for (let i = 0; i < ordered.length; i++) {
        await sql`UPDATE meeting_agenda_items SET display_order = ${1000 + i} WHERE id = ${ordered[i]} AND meeting_id = ${meetingId}`;
      }
      for (let i = 0; i < ordered.length; i++) {
        await sql`UPDATE meeting_agenda_items SET display_order = ${i}, version = version + 1, updated_at = now() WHERE id = ${ordered[i]} AND meeting_id = ${meetingId}`;
      }
      const rows = await sql`
        UPDATE meetings SET agenda_version = agenda_version + 1, version = version + 1, updated_at = now()
        WHERE id = ${meetingId} RETURNING agenda_version
      `;
      await emit(sql, 'agenda.reordered', {
        aggregateId: meetingId,
        tenantId: String(tenantId),
        payload: { meetingId, order: ordered },
      });
      return { meeting_id: meetingId, agenda_version: rows[0].agenda_version, order: ordered };
    });
  }

  @Post(':meetingId/agenda-items/:itemId/start')
  @HttpCode(200)
  async itemStart(
    @Param('meetingId') meetingId: string,
    @Param('itemId') itemId: string,
    @Body() body: LifecycleDto,
    @Auth() user: CurrentUser,
  ) {
    return this.itemAction(meetingId, itemId, 'start', body, user);
  }

  @Post(':meetingId/agenda-items/:itemId/pause')
  @HttpCode(200)
  async itemPause(
    @Param('meetingId') meetingId: string,
    @Param('itemId') itemId: string,
    @Body() body: LifecycleDto,
    @Auth() user: CurrentUser,
  ) {
    return this.itemAction(meetingId, itemId, 'pause', body, user);
  }

  @Post(':meetingId/agenda-items/:itemId/resume')
  @HttpCode(200)
  async itemResume(
    @Param('meetingId') meetingId: string,
    @Param('itemId') itemId: string,
    @Body() body: LifecycleDto,
    @Auth() user: CurrentUser,
  ) {
    return this.itemAction(meetingId, itemId, 'resume', body, user);
  }

  @Post(':meetingId/agenda-items/:itemId/complete')
  @HttpCode(200)
  async itemComplete(
    @Param('meetingId') meetingId: string,
    @Param('itemId') itemId: string,
    @Body() body: LifecycleDto,
    @Auth() user: CurrentUser,
  ) {
    return this.itemAction(meetingId, itemId, 'complete', body, user);
  }

  @Post(':meetingId/agenda-items/:itemId/skip')
  @HttpCode(200)
  async itemSkip(
    @Param('meetingId') meetingId: string,
    @Param('itemId') itemId: string,
    @Body() body: LifecycleDto,
    @Auth() user: CurrentUser,
  ) {
    return this.itemAction(meetingId, itemId, 'skip', body, user);
  }

  private async itemAction(
    meetingId: string,
    itemId: string,
    action: string,
    body: LifecycleDto | undefined,
    user: CurrentUser,
  ) {
    return this.db.scoped(user.user_id, async (sql) => {
      const itemTenant = await requireRowPermission(sql, user.user_id, 'meeting_agenda_items', itemId, 'edit');
      const itRows = await sql`
        SELECT status, version, paused_at FROM meeting_agenda_items WHERE id = ${itemId} AND meeting_id = ${meetingId}
      `;
      const it = itRows[0] as Row | undefined;
      if (!it) {
        throw new HttpException({ detail: 'Agenda item not found' }, HttpStatus.NOT_FOUND);
      }
      if (!ITEM_ALLOWED_FROM[action].has(it.status as string)) {
        throw new HttpException(
          { detail: `Cannot ${action} a segment in state '${it.status}'` },
          HttpStatus.CONFLICT,
        );
      }
      if (body && body.expected_version != null && (it.version as number) !== body.expected_version) {
        throw new HttpException(
          { detail: `Stale segment version (have ${it.version}, sent ${body.expected_version})` },
          HttpStatus.CONFLICT,
        );
      }

      const target = ITEM_TARGET[action];
      const setExtra =
        action === 'start'
          ? sql`, started_at = COALESCE(started_at, now())`
          : action === 'pause'
            ? sql`, paused_at = now()`
            : action === 'resume' || action === 'complete'
              ? sql`, accumulated_paused_seconds = accumulated_paused_seconds + CASE WHEN paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now()-paused_at))::int ELSE 0 END, paused_at = NULL${
                  action === 'complete' ? sql`, completed_at = now()` : sql``
                }`
              : sql``;
      const rows = await sql`
        UPDATE meeting_agenda_items SET status = ${target}, version = version + 1, updated_at = now()${setExtra}
        WHERE id = ${itemId} AND meeting_id = ${meetingId}
        RETURNING id, segment_type, title, description, duration_seconds, display_order, status,
                  started_at, paused_at, completed_at, accumulated_paused_seconds, notes, version
      `;
      await emit(sql, 'segment.updated', {
        aggregateId: meetingId,
        tenantId: String(itemTenant),
        payload: { meetingId, itemId, action, status: target },
      });
      return itemDto(rows[0] as Row);
    });
  }

  // ---- templates delete, meeting update/delete (parametric, declared last) --
  @Delete('templates/:templateId')
  async deleteTemplate(@Param('templateId') templateId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const res = await sql`DELETE FROM agenda_templates WHERE id = ${templateId}`;
      return { deleted: commandTag(res) };
    });
  }

  @Patch(':meetingId')
  async updateMeeting(@Param('meetingId') meetingId: string, @Body() body: UpdateMeetingDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'edit');
      // atomic conditional update: only applies when the version still matches
      const rows = await sql`
        UPDATE meetings SET
            title = COALESCE(${body.title ?? null}, title),
            scheduled_at = COALESCE(${body.scheduled_at ?? null}, scheduled_at),
            notes = COALESCE(${body.notes ?? null}, notes),
            version = version + 1,
            updated_at = now()
        WHERE id = ${meetingId} AND (${body.expected_version ?? null}::int IS NULL OR version = ${body.expected_version ?? null}::int)
        RETURNING id, title, status, scheduled_at, tenant_id, version
      `;
      const row = rows[0] as Row | undefined;
      if (!row) {
        // distinguish "gone" from "stale version" for a useful client message
        const existsRows = await sql`SELECT version FROM meetings WHERE id = ${meetingId}`;
        const exists = existsRows[0]?.version;
        if (exists == null) {
          throw new HttpException({ detail: 'Meeting not found or not accessible' }, HttpStatus.NOT_FOUND);
        }
        throw new HttpException(
          { detail: `Stale meeting version (current ${exists}, sent ${body.expected_version ?? null})` },
          HttpStatus.CONFLICT,
        );
      }
      return {
        id: String(row.id),
        title: row.title,
        status: row.status,
        scheduled_at: iso(row.scheduled_at),
        tenant_id: String(row.tenant_id),
        version: row.version,
      };
    });
  }

  @Delete(':meetingId')
  async deleteMeeting(@Param('meetingId') meetingId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'meetings', meetingId, 'delete');
      const res = await sql`DELETE FROM meetings WHERE id = ${meetingId}`;
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [MeetingsController] })
export class MeetingsModule {}
