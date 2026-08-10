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
import { commandTag } from '../common/fund-access';
import { emit } from '../common/outbox';
import { LEADERSHIP_ROLES, effectiveRole, requireLeadership, requirePermission } from '../common/permissions';
import { sanitizeHtml } from '../common/sanitizer';
import { DatabaseService, ScopedSql } from '../database/database.service';
import {
  broadcastTo,
  teamAnnouncementsChannel,
  tenantAnnouncementsChannel,
} from '../integrations/realtime-broadcast';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

class NewAnnouncementDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() body?: string | null;
  @IsOptional() @IsString() category?: string; // win | news | update | general
  @IsOptional() @IsString() audience?: string; // tenant | team
  @IsOptional() @IsString() team_id?: string | null;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() requires_ack?: boolean;
  @IsOptional() @IsString() priority?: string; // normal | high
  @IsOptional() @IsString() body_format?: string; // html | markdown | plain
  @IsOptional() @IsString() publish_at?: string | null; // ISO datetime; future → scheduled post
}

class UpdateAnnouncementDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() body?: string | null;
  @IsOptional() @IsString() category?: string | null;
  @IsOptional() @IsBoolean() pinned?: boolean | null;
  @IsOptional() @IsBoolean() requires_ack?: boolean | null;
  @IsOptional() @IsString() priority?: string | null;
  @IsOptional() @IsBoolean() archived?: boolean | null; // true → status='archived'
}

class CommentRequestDto {
  @IsString() body!: string;
}

class ReactRequestDto {
  @IsString() emoji!: string;
}

/**
 * Parse an ISO datetime to a Date. Faithful port of announcements.py::_parse_dt:
 * None/blank → null; a naive (tz-less) datetime is treated as UTC; anything
 * unparseable → 422. asyncpg needed a datetime object; postgres.js takes the Date.
 */
function parseDt(publishAt: string | null | undefined): Date | null {
  if (!publishAt) return null;
  let s = publishAt.replace('Z', '+00:00');
  // No offset on a datetime → assume UTC, mirroring `dt.replace(tzinfo=utc)`.
  if (s.includes('T') && !/[+-]\d{2}:?\d{2}$/.test(s)) {
    s = `${s}+00:00`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) {
    throw new HttpException({ detail: 'publish_at must be an ISO datetime' }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return dt;
}

/**
 * Cheap COUNT of who this post will reach — for immediate UX only. The
 * authoritative recipient set is snapshotted by the worker into
 * announcement_recipients (docs §4); this never fans anything out.
 */
async function audienceSize(
  sql: ScopedSql,
  tenantId: string,
  audience: string,
  teamId: string | null,
): Promise<number> {
  if (audience === 'team' && teamId) {
    const rows = await sql`SELECT count(*) AS n FROM team_members WHERE team_id = ${teamId}`;
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await sql`SELECT count(DISTINCT user_id) AS n FROM tenant_memberships WHERE tenant_id = ${tenantId}`;
  return Number(rows[0]?.n ?? 0);
}

async function upsertReceipt(
  sql: ScopedSql,
  annId: string,
  tenantId: string,
  userId: string,
  ack = false,
): Promise<void> {
  if (ack) {
    await sql`
      INSERT INTO announcement_receipts (announcement_id, user_id, tenant_id, read_at, ack_at)
      VALUES (${annId}, ${userId}, ${tenantId}, now(), now())
      ON CONFLICT (announcement_id, user_id) DO UPDATE SET ack_at = now(),
          read_at = COALESCE(announcement_receipts.read_at, now())
    `;
  } else {
    await sql`
      INSERT INTO announcement_receipts (announcement_id, user_id, tenant_id, read_at)
      VALUES (${annId}, ${userId}, ${tenantId}, now())
      ON CONFLICT (announcement_id, user_id) DO UPDATE SET read_at = COALESCE(announcement_receipts.read_at, now())
    `;
  }
}

/**
 * Best-effort live nudge for feed interactions (comment / react / ack). Fired
 * AFTER commit, never raises (broadcastTo is a best-effort transport). Faithful
 * port of announcements.py::_broadcast_nudge.
 */
async function broadcastNudge(
  tenantId: string,
  audience: string,
  teamId: string | null,
  event: string,
  annId: string,
): Promise<void> {
  const ch =
    audience === 'team' && teamId
      ? teamAnnouncementsChannel(String(teamId))
      : tenantAnnouncementsChannel(String(tenantId));
  await broadcastTo(ch, event, { announcementId: String(annId) });
}

/** Company/team announcements: feed, receipts, acks, reactions, comments, delivery reports. Faithful port of announcements.py. */
@Controller('announcements')
@UseGuards(AuthGuard)
export class AnnouncementsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listAnnouncements(
    @Auth() user: CurrentUser,
    @Query('tenant_id') tenantId?: string,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const target = tenantId || user.active_tenant_id || null;
    const me = user.user_id;
    return this.db.scoped(user.user_id, async (sql) => {
      const adminRows = await sql`SELECT COALESCE(is_fund_admin, false) AS is_fund_admin FROM users WHERE id = ${me}`;
      const isFundAdmin = Boolean(adminRows[0]?.is_fund_admin ?? false);
      const teamRows = await sql`SELECT team_id FROM team_members WHERE user_id = ${me}`;
      const myTeams = teamRows.map((r) => r.team_id as string);
      const myTeamsParam = myTeams.length ? myTeams : [ZERO_UUID];

      const rows = await sql`
        SELECT a.id, a.title, a.body, a.category, a.audience, a.team_id, a.pinned,
               a.requires_ack, a.priority, a.body_format, a.status, a.publish_at,
               a.created_at, a.author_id, a.tenant_id,
               u.name AS author_name, t.name AS team_name,
               (SELECT count(*) FROM announcement_comments c WHERE c.announcement_id=a.id) AS comment_count,
               (SELECT count(*) FROM announcement_recipients ar WHERE ar.announcement_id=a.id) AS recipients,
               (SELECT count(*) FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.ack_at IS NOT NULL) AS ack_count,
               (SELECT read_at FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=${me}) AS my_read_at,
               (SELECT ack_at  FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=${me}) AS my_ack_at
        FROM announcements a
        LEFT JOIN users u ON u.id=a.author_id
        LEFT JOIN teams t ON t.id=a.team_id
        WHERE (${target}::uuid IS NULL OR a.tenant_id=${target}::uuid)
          AND (${category ?? null}::text IS NULL OR a.category=${category ?? null}::text)
          AND (${q ?? null}::text IS NULL
               OR a.search_tsv @@ websearch_to_tsquery('english', ${q ?? null})
               OR a.title ILIKE '%'||${q ?? null}||'%')
          AND (${since ?? null}::timestamptz IS NULL OR a.created_at >= ${since ?? null}::timestamptz)
          AND (a.status='published' OR (a.status='scheduled' AND (a.author_id=${me} OR ${isFundAdmin})))
          AND (a.audience='tenant' OR a.author_id=${me} OR ${isFundAdmin} OR a.team_id = ANY(${myTeamsParam}::uuid[]))
        ORDER BY a.pinned DESC, a.created_at DESC
      `;

      const annIds = rows.map((r) => r.id as string);
      let reacts: readonly Record<string, unknown>[] = [];
      if (annIds.length) {
        reacts = await sql`
          SELECT announcement_id, emoji, count(*) AS n,
                 bool_or(user_id=${me}) AS mine
          FROM announcement_reactions WHERE announcement_id = ANY(${annIds}::uuid[])
          GROUP BY announcement_id, emoji
        `;
      }

      const byAnn = new Map<string, Array<{ emoji: unknown; count: unknown; mine: unknown }>>();
      for (const r of reacts) {
        const key = String(r.announcement_id);
        if (!byAnn.has(key)) byAnn.set(key, []);
        byAnn.get(key)!.push({ emoji: r.emoji, count: r.n, mine: r.mine });
      }

      return rows.map((r) => {
        const recips = Number(r.recipients ?? 0) || 0;
        const ackCount = Number(r.ack_count ?? 0) || 0;
        return {
          ...r,
          ack_pct: recips ? Math.round((ackCount / recips) * 100) : 0,
          reactions: byAnn.get(String(r.id)) ?? [],
        };
      });
    });
  }

  @Post()
  @HttpCode(200)
  async createAnnouncement(@Body() body: NewAnnouncementDto, @Auth() user: CurrentUser) {
    const audience = body.audience ?? 'tenant';
    const bodyFormat = body.body_format ?? 'html';
    const publishDt = parseDt(body.publish_at);
    const scheduled = publishDt !== null && publishDt.getTime() > Date.now();
    const cleanBody = bodyFormat === 'html' ? sanitizeHtml(body.body ?? null) : (body.body ?? null);
    const teamIdVal = audience === 'team' ? (body.team_id ?? null) : null;

    return this.db.scoped(user.user_id, async (sql) => {
      if (audience === 'tenant') {
        await requireLeadership(sql, user.user_id, body.tenant_id);
      } else {
        await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      }

      const rows = await sql`
        INSERT INTO announcements
            (tenant_id, author_id, title, body, category, audience, team_id,
             pinned, requires_ack, priority, body_format, status, publish_at)
        VALUES (${body.tenant_id}, ${user.user_id}, ${body.title}, ${cleanBody}, ${body.category ?? 'general'},
                ${audience}, ${teamIdVal},
                ${body.pinned ?? false}, ${body.requires_ack ?? false}, ${body.priority ?? 'normal'}, ${bodyFormat},
                ${scheduled ? 'scheduled' : 'published'}, ${scheduled ? publishDt : null})
        RETURNING id
      `;
      const annId = String(rows[0].id);

      // Estimate reach for the UI now; the worker snapshots the real set later.
      const est = await audienceSize(sql, body.tenant_id, audience, body.team_id ?? null);

      // Publish now → emit the fan-out event in THIS transaction (durable with the
      // row). Scheduled → the pg_cron job (migration 33) emits it when due.
      if (!scheduled) {
        await emit(sql, 'announcement.published', {
          aggregateId: annId,
          tenantId: body.tenant_id,
          aggregateType: 'announcement',
          payload: { announcementId: annId, tenantId: body.tenant_id, actorId: user.user_id },
        });
      }

      return {
        id: annId,
        status: scheduled ? 'scheduled' : 'published',
        estimated_recipients: est,
        scheduled_for: scheduled ? body.publish_at : null,
      };
    });
  }

  @Patch(':annId')
  async updateAnnouncement(
    @Param('annId') annId: string,
    @Body() body: UpdateAnnouncementDto,
    @Auth() user: CurrentUser,
  ) {
    const cleanBody = body.body !== undefined && body.body !== null ? sanitizeHtml(body.body) : null;
    return this.db.scoped(user.user_id, async (sql) => {
      const aRows = await sql`SELECT tenant_id, author_id FROM announcements WHERE id = ${annId}`;
      const a = aRows[0];
      if (!a) {
        throw new HttpException({ detail: 'Announcement not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      const role = await effectiveRole(sql, user.user_id, String(a.tenant_id));
      if (String(a.author_id) !== user.user_id && (role === null || !LEADERSHIP_ROLES.has(role))) {
        throw new HttpException({ detail: 'Only the author or leadership can edit this' }, HttpStatus.FORBIDDEN);
      }
      const newStatus = body.archived ? 'archived' : null;
      const rows = await sql`
        UPDATE announcements SET title=COALESCE(${body.title ?? null}, title), body=COALESCE(${cleanBody}, body),
            category=COALESCE(${body.category ?? null}, category), pinned=COALESCE(${body.pinned ?? null}, pinned),
            requires_ack=COALESCE(${body.requires_ack ?? null}, requires_ack), priority=COALESCE(${body.priority ?? null}, priority),
            status=COALESCE(${newStatus}, status), updated_at=now()
        WHERE id = ${annId} RETURNING id, pinned, status
      `;
      // Nudge open feeds to refetch the edited post.
      await emit(sql, 'announcement.updated', {
        aggregateId: annId,
        tenantId: String(a.tenant_id),
        aggregateType: 'announcement',
        payload: { announcementId: annId, tenantId: String(a.tenant_id), actorId: user.user_id },
      });
      return rows[0];
    });
  }

  @Delete(':annId')
  async deleteAnnouncement(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const aRows = await sql`SELECT tenant_id, author_id FROM announcements WHERE id = ${annId}`;
      const a = aRows[0];
      if (!a) {
        throw new HttpException({ detail: 'Not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      const role = await effectiveRole(sql, user.user_id, String(a.tenant_id));
      if (String(a.author_id) !== user.user_id && (role === null || !LEADERSHIP_ROLES.has(role))) {
        throw new HttpException({ detail: 'Only the author or leadership can delete this' }, HttpStatus.FORBIDDEN);
      }
      const res = await sql`DELETE FROM announcements WHERE id = ${annId}`;
      return { deleted: commandTag(res) };
    });
  }

  @Post(':annId/read')
  @HttpCode(200)
  async markRead(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT tenant_id FROM announcements WHERE id = ${annId}`;
      const tid = rows[0]?.tenant_id;
      if (tid == null) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      await upsertReceipt(sql, annId, String(tid), user.user_id);
      return { read: true };
    });
  }

  @Post(':annId/ack')
  @HttpCode(200)
  async acknowledge(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    const a = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT tenant_id, audience, team_id FROM announcements WHERE id = ${annId}`;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      await upsertReceipt(sql, annId, String(row.tenant_id), user.user_id, true);
      return row;
    });
    // Live-update everyone's feed counts + any open ack tracker.
    await broadcastNudge(String(a.tenant_id), String(a.audience), a.team_id as string | null, 'announcement.acked', annId);
    return { acknowledged: true };
  }

  @Post(':annId/react')
  @HttpCode(200)
  async react(@Param('annId') annId: string, @Body() body: ReactRequestDto, @Auth() user: CurrentUser) {
    const result = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT tenant_id, audience, team_id FROM announcements WHERE id = ${annId}`;
      const a = rows[0];
      if (!a) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      const existing = await sql`
        SELECT 1 FROM announcement_reactions WHERE announcement_id=${annId} AND user_id=${user.user_id} AND emoji=${body.emoji}
      `;
      let reacted: boolean;
      if (existing.length) {
        await sql`DELETE FROM announcement_reactions WHERE announcement_id=${annId} AND user_id=${user.user_id} AND emoji=${body.emoji}`;
        reacted = false;
      } else {
        await sql`INSERT INTO announcement_reactions (announcement_id, user_id, tenant_id, emoji) VALUES (${annId}, ${user.user_id}, ${a.tenant_id}, ${body.emoji})`;
        reacted = true;
      }
      return { a, reacted };
    });
    await broadcastNudge(
      String(result.a.tenant_id),
      String(result.a.audience),
      result.a.team_id as string | null,
      'announcement.reacted',
      annId,
    );
    return { reacted: result.reacted };
  }

  @Get(':annId/comments')
  async listComments(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT c.id, c.body, c.created_at, u.name AS author_name
        FROM announcement_comments c LEFT JOIN users u ON u.id=c.user_id
        WHERE c.announcement_id = ${annId} ORDER BY c.created_at
      `;
    });
  }

  @Post(':annId/comments')
  @HttpCode(200)
  async addComment(@Param('annId') annId: string, @Body() body: CommentRequestDto, @Auth() user: CurrentUser) {
    const result = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT tenant_id, audience, team_id FROM announcements WHERE id = ${annId}`;
      const a = rows[0];
      if (!a) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      const inserted = await sql`
        INSERT INTO announcement_comments (announcement_id, tenant_id, user_id, body)
        VALUES (${annId}, ${a.tenant_id}, ${user.user_id}, ${body.body}) RETURNING id
      `;
      return { a, id: String(inserted[0].id) };
    });
    await broadcastNudge(
      String(result.a.tenant_id),
      String(result.a.audience),
      result.a.team_id as string | null,
      'announcement.commented',
      annId,
    );
    return { id: result.id };
  }

  @Get(':annId/acks')
  async ackTracker(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const aRows = await sql`SELECT tenant_id FROM announcements WHERE id = ${annId}`;
      const a = aRows[0];
      if (!a) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(a.tenant_id));
      const recips = await sql`
        SELECT u.name, r.read_at, r.ack_at
        FROM announcement_recipients ar
        JOIN users u ON u.id=ar.user_id
        LEFT JOIN announcement_receipts r ON r.announcement_id=ar.announcement_id AND r.user_id=ar.user_id
        WHERE ar.announcement_id = ${annId}
        ORDER BY (r.ack_at IS NULL), u.name
      `;
      const rows = recips.map((r) => ({ ...r }));
      const total = rows.length;
      const acked = rows.filter((r) => r.ack_at).length;
      return {
        total,
        acknowledged: acked,
        completion_pct: total ? Math.round((acked / total) * 100) : 0,
        recipients: rows,
      };
    });
  }

  @Get(':annId/deliveries')
  async deliveryReport(@Param('annId') annId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const aRows = await sql`SELECT tenant_id FROM announcements WHERE id = ${annId}`;
      const a = aRows[0];
      if (!a) {
        throw new HttpException({ detail: 'Not found' }, HttpStatus.NOT_FOUND);
      }
      await requireLeadership(sql, user.user_id, String(a.tenant_id));
      return sql`
        SELECT channel, status, count(*) AS n
        FROM notification_deliveries WHERE announcement_id = ${annId}
        GROUP BY channel, status ORDER BY channel, status
      `;
    });
  }
}

@Module({ controllers: [AnnouncementsController] })
export class AnnouncementsModule {}
