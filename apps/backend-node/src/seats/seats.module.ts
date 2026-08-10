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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { commandTag } from '../common/fund-access';
import { requirePermission, requireRowPermission } from '../common/permissions';
import { DatabaseService, ScopedSql } from '../database/database.service';
import { LucidService } from '../integrations/lucid';

// Only Lucid's own hosts may be embedded — prevents an admin (or a copy-paste
// mistake) from framing an arbitrary/phishing page in the portal.
const LUCID_HOSTS = new Set(['lucid.app', 'www.lucid.app', 'lucidchart.com', 'www.lucidchart.com']);

/**
 * Accept a bare URL OR a pasted <iframe> snippet; return the validated Lucid src
 * URL, or throw 400. Faithful port of seats.py `_clean_embed_url`.
 */
function cleanEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  raw = raw.trim();
  const m = raw.match(/src=["']([^"']+)["']/); // pull src out of an <iframe …> paste
  const url = m ? m[1] : raw;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpException(
      {
        detail:
          'Embed URL must be an https link on lucid.app or lucidchart.com ' +
          '(from File → Share → Embed → Activate Embed Code).',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (parsed.protocol !== 'https:' || !LUCID_HOSTS.has(parsed.hostname)) {
    throw new HttpException(
      {
        detail:
          'Embed URL must be an https link on lucid.app or lucidchart.com ' +
          '(from File → Share → Embed → Activate Embed Code).',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  // A personal invitation/share token must never be embedded — it can grant access.
  if ((parsed.search || '').toLowerCase().includes('invitationid') || url.toLowerCase().includes('invitationid')) {
    throw new HttpException(
      {
        detail:
          "That's a personal invitation link (it contains an invitationId) — don't embed it, " +
          'it can grant others access to your document. In Lucid use File → Share → Embed → ' +
          'Activate Embed Code and paste THAT link instead.',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  // Must be an actual embed link, not an /edit or share link.
  if (!parsed.pathname.includes('/documents/embed') && !parsed.pathname.includes('/documents/embeddedchart')) {
    throw new HttpException(
      {
        detail:
          'That looks like an edit/share link, not an embed link. In Lucid: File → Share → Embed → ' +
          'Activate Embed Code — the embed URL looks like https://lucid.app/documents/embed/…',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return url;
}

/** Replace a seat's holder set; return the primary (first) holder id. */
async function syncHolders(
  sql: ScopedSql,
  seatId: string,
  tenantId: string,
  holderIds: string[],
): Promise<string | null> {
  await sql`DELETE FROM seat_holders WHERE seat_id = ${seatId}`;
  const seen: string[] = [];
  for (const uid of holderIds) {
    if (uid && !seen.includes(uid)) {
      await sql`
        INSERT INTO seat_holders (seat_id, user_id, tenant_id)
        VALUES (${seatId}, ${uid}, ${tenantId})
        ON CONFLICT (seat_id, user_id) DO NOTHING
      `;
      seen.push(uid);
    }
  }
  return seen.length ? seen[0] : null;
}

class NewSeatDto {
  @IsString() tenant_id!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() holder_user_id?: string | null;
  @IsOptional() @IsArray() holder_ids?: string[] | null; // multiple person-to-role assignments
  @IsOptional() @IsString() parent_seat_id?: string | null;
  @IsOptional() @IsString() responsibilities?: string | null; // up to 5 newline bullets (UI-enforced)
  @IsOptional() @IsBoolean() gwc_gets?: boolean | null;
  @IsOptional() @IsBoolean() gwc_wants?: boolean | null;
  @IsOptional() @IsBoolean() gwc_capacity?: boolean | null;
}

class UpdateSeatDto {
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() holder_user_id?: string | null;
  @IsOptional() @IsArray() holder_ids?: string[] | null;
  @IsOptional() @IsString() parent_seat_id?: string | null;
  @IsOptional() @IsString() responsibilities?: string | null;
  @IsOptional() @IsBoolean() gwc_gets?: boolean | null;
  @IsOptional() @IsBoolean() gwc_wants?: boolean | null;
  @IsOptional() @IsBoolean() gwc_capacity?: boolean | null;
}

class ReparentDto {
  @IsOptional() @IsString() parent_seat_id?: string | null; // drag-and-drop: new parent (null = top level)
}

class PublishDto {
  @IsString() tenant_id!: string;
  @IsOptional() @IsString() label?: string | null;
}

class EmbedDto {
  @IsString() tenant_id!: string;
  @IsOptional() @IsString() embed_url?: string | null; // Lucid embed URL (or a pasted <iframe> snippet); null clears it
}

class EmbedIdDto {
  @IsString() tenant_id!: string;
  @IsOptional() @IsString() embed_id?: string | null; // Lucid embed/document id for token-based mode; null clears it
}

/**
 * The Accountability Chart + Lucidchart embeds. Faithful port of
 * backend/app/routers/seats.py.
 */
@Controller('seats')
@UseGuards(AuthGuard)
export class SeatsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly lucid: LucidService,
  ) {}

  /** The Accountability Chart — a flat list the UI renders (and drag-reparents) as a tree. */
  @Get()
  async listSeats(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    const rows = await this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT s.id, s.title, s.parent_seat_id, s.responsibilities, s.tenant_id, s.sort_order,
               s.holder_user_id, u.name AS holder_name,
               s.gwc_gets, s.gwc_wants, s.gwc_capacity,
               COALESCE(
                 (SELECT json_agg(json_build_object('id', sh.user_id, 'name', hu.name) ORDER BY hu.name)
                  FROM seat_holders sh JOIN users hu ON hu.id = sh.user_id
                  WHERE sh.seat_id = s.id),
                 '[]'::json) AS holders
        FROM seats s
        LEFT JOIN users u ON u.id = s.holder_user_id
        WHERE (${target}::uuid IS NULL OR s.tenant_id = ${target}::uuid)
        ORDER BY s.sort_order, s.created_at
      `;
    });
    return rows.map((r) => {
      const d = r as Record<string, unknown>;
      if (typeof d.holders === 'string') d.holders = JSON.parse(d.holders);
      d.gwc_score = [d.gwc_gets, d.gwc_wants, d.gwc_capacity].filter(Boolean).length;
      return d;
    });
  }

  @Get('versions')
  async listVersions(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT v.id, v.label, v.seat_count, v.created_at, u.name AS created_by_name
        FROM org_chart_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE (${target}::uuid IS NULL OR v.tenant_id = ${target}::uuid)
        ORDER BY v.created_at DESC LIMIT 25
      `;
    });
  }

  /**
   * The tenant's Lucidchart embed URL (Approach 1, cookie-based) — anyone who can
   * view the tenant can see it; it carries no secrets.
   */
  @Get('embed')
  async getEmbed(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    const url = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT lucid_embed_url FROM organizations WHERE id = ${target}`;
      return (rows[0]?.lucid_embed_url as string | null) ?? null;
    });
    return { embed_url: url };
  }

  /**
   * Set/clear the tenant's Lucidchart embed URL. Requires edit rights on the tenant.
   * The URL is validated to a Lucid host — no API keys or secrets are involved.
   */
  @Put('embed')
  async setEmbed(@Body() body: EmbedDto, @Auth() user: CurrentUser) {
    const url = cleanEmbedUrl(body.embed_url);
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'edit');
      await sql`UPDATE organizations SET lucid_embed_url = ${url} WHERE id = ${body.tenant_id}`;
      return { embed_url: url };
    });
  }

  /** Set/clear the tenant's Lucid embed/document id for TOKEN-based embeds. Edit rights required. */
  @Put('embed-id')
  async setEmbedId(@Body() body: EmbedIdDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'edit');
      const eid = (body.embed_id || '').trim() || null;
      await sql`UPDATE organizations SET lucid_embed_id = ${eid} WHERE id = ${body.tenant_id}`;
      return { embed_id: eid };
    });
  }

  /**
   * Approach 2: mint a SHORT-LIVED Lucid session token server-side and return a
   * ready-to-iframe URL. Viewers need no Lucid account and never see a login prompt.
   * Reports `configured: false` (not an error) when the Lucid OAuth env isn't set up,
   * so the UI can explain what to do.
   */
  @Get('embed-session')
  async embedSession(@Auth() user: CurrentUser, @Query('tenant_id') tenantId?: string) {
    const target = tenantId || user.active_tenant_id || null;
    if (!this.lucid.isConfigured()) {
      return { configured: false, reason: 'Lucid OAuth credentials not set in backend .env' };
    }
    const embedId = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`SELECT lucid_embed_id FROM organizations WHERE id = ${target}`;
      return (rows[0]?.lucid_embed_id as string | null) ?? null;
    });
    if (!embedId) {
      return { configured: true, embed_id: null };
    }
    let url: string;
    try {
      url = await this.lucid.mintEmbedUrl(embedId);
    } catch (e) {
      throw new HttpException(
        { detail: `Lucid embed session failed: ${e instanceof Error ? e.message : String(e)}` },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { configured: true, embed_id: embedId, embed_url: url };
  }

  /**
   * What the seat's holder(s) own across modules — Scorecard KPIs, VCBs, and To-Dos.
   * This is the 'role linked to ownership' requirement, resolved live.
   */
  @Get(':seat_id/links')
  async seatLinks(@Param('seat_id') seatId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const seat = (await sql`SELECT tenant_id FROM seats WHERE id = ${seatId}`)[0];
      if (!seat) {
        throw new HttpException({ detail: 'Seat not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      const holderRows = await sql`SELECT user_id FROM seat_holders WHERE seat_id = ${seatId}`;
      const holderIds = holderRows.map((r) => r.user_id as string);
      if (holderIds.length === 0) {
        return { kpis: [], vcbs: [], todos: [] };
      }
      const kpis = await sql`
        SELECT id, title FROM kpis WHERE owner_id = ANY(${holderIds}::uuid[]) ORDER BY title
      `;
      const vcbs = await sql`
        SELECT id, title FROM vcbs WHERE created_by = ANY(${holderIds}::uuid[]) ORDER BY title
      `;
      const todos = await sql`
        SELECT id, title, status FROM todos
        WHERE owner_id = ANY(${holderIds}::uuid[]) AND status = 'open'
        ORDER BY due_date NULLS LAST
      `;
      return { kpis, vcbs, todos };
    });
  }

  @Post()
  @HttpCode(200)
  async createSeat(@Body() body: NewSeatDto, @Auth() user: CurrentUser) {
    let holders = body.holder_ids != null ? body.holder_ids : body.holder_user_id ? [body.holder_user_id] : [];
    holders = holders.filter((h) => h);
    const primary = holders.length ? holders[0] : null;
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'create');
      const nxtRows = await sql`
        SELECT COALESCE(MAX(sort_order) + 1, 0) AS nxt FROM seats WHERE tenant_id = ${body.tenant_id}
      `;
      const nxt = nxtRows[0].nxt as number;
      const rows = await sql`
        INSERT INTO seats (tenant_id, title, holder_user_id, parent_seat_id, responsibilities,
                           gwc_gets, gwc_wants, gwc_capacity, sort_order)
        VALUES (${body.tenant_id}, ${body.title}, ${primary}, ${body.parent_seat_id ?? null},
                ${body.responsibilities ?? null}, ${body.gwc_gets ?? null}, ${body.gwc_wants ?? null},
                ${body.gwc_capacity ?? null}, ${nxt})
        RETURNING id, title, parent_seat_id, tenant_id
      `;
      const row = rows[0];
      if (holders.length) {
        await syncHolders(sql, row.id as string, body.tenant_id, holders);
      }
      return row;
    });
  }

  @Patch(':seat_id')
  async updateSeat(@Param('seat_id') seatId: string, @Body() body: UpdateSeatDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      const tenantId = await requireRowPermission(sql, user.user_id, 'seats', seatId, 'edit');
      let primary: string | null = null;
      if (body.holder_ids != null) {
        primary = await syncHolders(sql, seatId, String(tenantId), body.holder_ids);
      }
      const holderOverride = primary || body.holder_user_id || null;
      const rows = await sql`
        UPDATE seats SET
            title = COALESCE(${body.title ?? null}, title),
            holder_user_id = COALESCE(${holderOverride}, holder_user_id),
            parent_seat_id = COALESCE(${body.parent_seat_id ?? null}, parent_seat_id),
            responsibilities = COALESCE(${body.responsibilities ?? null}, responsibilities),
            gwc_gets = COALESCE(${body.gwc_gets ?? null}, gwc_gets),
            gwc_wants = COALESCE(${body.gwc_wants ?? null}, gwc_wants),
            gwc_capacity = COALESCE(${body.gwc_capacity ?? null}, gwc_capacity)
        WHERE id = ${seatId}
        RETURNING id, title, tenant_id
      `;
      const row = rows[0];
      if (!row) {
        throw new HttpException({ detail: 'Seat not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      return row;
    });
  }

  /**
   * Drag-and-drop: move a seat under a new parent (or to the top). Guards against
   * making a seat its own ancestor (which would orphan a subtree).
   */
  @Post(':seat_id/reparent')
  @HttpCode(200)
  async reparentSeat(@Param('seat_id') seatId: string, @Body() body: ReparentDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'seats', seatId, 'edit');
      const newParent = body.parent_seat_id ?? null;
      if (newParent === seatId) {
        throw new HttpException({ detail: "A seat can't report to itself" }, HttpStatus.BAD_REQUEST);
      }
      let cur: string | null = newParent;
      while (cur) {
        if (cur === seatId) {
          throw new HttpException({ detail: 'That would create a reporting loop' }, HttpStatus.BAD_REQUEST);
        }
        const nxt = (await sql`SELECT parent_seat_id FROM seats WHERE id = ${cur}`)[0]?.parent_seat_id;
        cur = nxt ? String(nxt) : null;
      }
      await sql`UPDATE seats SET parent_seat_id = ${newParent} WHERE id = ${seatId}`;
      return { reparented: true };
    });
  }

  /** Deleting a seat cascades to seats reporting under it (FK ON DELETE CASCADE). */
  @Delete(':seat_id')
  async deleteSeat(@Param('seat_id') seatId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireRowPermission(sql, user.user_id, 'seats', seatId, 'delete');
      const res = await sql`DELETE FROM seats WHERE id = ${seatId}`;
      return { deleted: commandTag(res) };
    });
  }

  /** Snapshot the whole chart into version history. */
  @Post('publish')
  @HttpCode(200)
  async publishChart(@Body() body: PublishDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requirePermission(sql, user.user_id, body.tenant_id, 'edit');
      const seats = await sql`
        SELECT id, title, parent_seat_id, holder_user_id, responsibilities,
               gwc_gets, gwc_wants, gwc_capacity
        FROM seats WHERE tenant_id = ${body.tenant_id} ORDER BY sort_order
      `;
      const snapshot = seats.map((s) => ({
        ...s,
        id: String(s.id),
        parent_seat_id: s.parent_seat_id ? String(s.parent_seat_id) : null,
        holder_user_id: s.holder_user_id ? String(s.holder_user_id) : null,
      }));
      const rows = await sql`
        INSERT INTO org_chart_versions (tenant_id, label, snapshot, seat_count, created_by)
        VALUES (${body.tenant_id}, ${body.label ?? null}, ${sql.json(snapshot)}, ${snapshot.length}, ${user.user_id})
        RETURNING id, created_at
      `;
      const row = rows[0];
      const createdAt = row.created_at as Date;
      return {
        id: String(row.id),
        seat_count: snapshot.length,
        created_at: createdAt.toISOString(),
      };
    });
  }
}

@Module({
  controllers: [SeatsController],
  providers: [LucidService],
})
export class SeatsModule {}
