import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { auditLog } from '../common/audit';
import { ConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { Auth, CurrentUser } from './current-user';
import { LoginDto, RefreshDto, SupabaseSessionDto, SwitchTenantDto } from './dto';
import { SecurityService } from './security';
import { SupabaseAuthService } from './supabase-auth';

type ReqWithCookies = FastifyRequest & { cookies?: Record<string, string | undefined> };

/**
 * Auth endpoints. Faithful port of backend/app/routers/auth.py — same paths,
 * same request/response shapes, same httpOnly-cookie behavior, so the frontend
 * (frontend/lib/api.js) works against this backend with zero changes.
 *
 * httpOnly cookies: the browser stores these and JS can't read them, so an XSS
 * bug can't exfiltrate the token. secure=false only because the demo runs on
 * http://localhost — set secure=true + add a CSRF token in production.
 */
const COOKIE_BASE = { httpOnly: true, sameSite: 'lax' as const, secure: false, path: '/' };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: SecurityService,
    private readonly supabase: SupabaseAuthService,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  private setAccessCookie(reply: FastifyReply, token: string): void {
    reply.setCookie('access_token', token, {
      ...COOKIE_BASE,
      maxAge: this.config.ACCESS_TOKEN_LIFETIME_MINUTES * 60,
    });
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie('refresh_token', token, {
      ...COOKIE_BASE,
      maxAge: this.config.REFRESH_TOKEN_LIFETIME_DAYS * 24 * 3600,
    });
  }

  private clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie('access_token', { path: '/' });
    reply.clearCookie('refresh_token', { path: '/' });
    reply.clearCookie('sb_refresh_token', { path: '/' });
  }

  /** Put a Supabase session into httpOnly cookies (cookies are per-host, not per-port). */
  private storeSupabaseSession(reply: FastifyReply, accessToken: string, refreshToken: string): void {
    const exp = this.supabase.unverifiedExp(accessToken);
    const maxAge = exp ? Math.max(60, Math.floor(exp - Date.now() / 1000)) : 3600;
    reply.setCookie('access_token', accessToken, { ...COOKIE_BASE, maxAge });
    reply.setCookie('sb_refresh_token', refreshToken, { ...COOKIE_BASE, maxAge: 30 * 24 * 3600 });
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    // Step 1: look up the user. `users` has no RLS — we don't know who this is
    // yet. This is the ONLY query in the app that runs without a scope set.
    const found = await this.db.scoped(null, async (sql) => {
      const rows = await sql`SELECT id, password_hash, name FROM users WHERE email = ${body.email}`;
      return rows[0];
    });

    if (!found || !this.security.verifyPassword(body.password, found.password_hash)) {
      throw new HttpException({ detail: 'Invalid email or password' }, HttpStatus.UNAUTHORIZED);
    }

    const userId = String(found.id);

    // Step 2: NOW look up what they can actually see — live, never trusted.
    const { tenants, isFundAdmin } = await this.auth.accessibleTenantsFor(userId);
    const defaultActiveTenant = isFundAdmin ? null : (tenants[0]?.id ?? null);

    const accessToken = this.security.createAccessToken(userId, defaultActiveTenant);
    const { raw, hash, expiresAt } = this.security.generateRefreshToken();

    await this.db.scoped(userId, async (sql) => {
      await sql`
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES (${userId}, ${hash}, ${expiresAt})
      `;
      await auditLog(sql, userId, 'login', {
        entityType: 'user',
        entityId: userId,
        detail: 'password',
      });
    });

    this.setAccessCookie(reply, accessToken);
    this.setRefreshCookie(reply, raw);

    return {
      user: { id: userId, name: found.name, email: body.email, is_fund_admin: isFundAdmin },
      accessible_tenants: tenants,
      active_tenant_id: defaultActiveTenant,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: ReqWithCookies,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body?: RefreshDto,
  ) {
    const rawRefresh = req.cookies?.refresh_token || body?.refresh_token;
    if (!rawRefresh) {
      throw new HttpException({ detail: 'No refresh token' }, HttpStatus.UNAUTHORIZED);
    }
    const tokenHash = this.security.hashRefreshToken(rawRefresh);

    const row = await this.db.scoped(null, async (sql) => {
      const rows = await sql`
        SELECT user_id FROM refresh_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > now()
      `;
      return rows[0];
    });

    if (!row) {
      throw new HttpException(
        { detail: 'Refresh token invalid, expired, or revoked' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const userId = String(row.user_id);
    // Re-check live access on refresh too — a grant revoked while this token was
    // still valid is caught here.
    const { tenants, isFundAdmin } = await this.auth.accessibleTenantsFor(userId);
    const defaultActiveTenant = isFundAdmin ? null : (tenants[0]?.id ?? null);

    const accessToken = this.security.createAccessToken(userId, defaultActiveTenant);
    this.setAccessCookie(reply, accessToken);
    return { accessible_tenants: tenants, active_tenant_id: defaultActiveTenant };
  }

  @Post('switch-tenant')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async switchTenant(
    @Body() body: SwitchTenantDto,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Auth() user: CurrentUser,
  ) {
    const tenantId = body.tenant_id ?? null;
    const allowed = await this.db.scoped(user.user_id, async (sql) => {
      if (tenantId === null) {
        const rows = await sql`
          SELECT COALESCE(is_fund_admin, false) AS ok FROM users WHERE id = ${user.user_id}
        `;
        return Boolean(rows[0]?.ok);
      }
      const rows = await sql`
        SELECT EXISTS (
          SELECT 1 FROM user_accessible_tenants(${user.user_id}::uuid) WHERE tenant_id = ${tenantId}::uuid
        ) AS ok
      `;
      return Boolean(rows[0]?.ok);
    });

    if (!allowed) {
      throw new HttpException(
        { detail: "You don't have access to that tenant" },
        HttpStatus.FORBIDDEN,
      );
    }

    const newToken = this.security.createAccessToken(user.user_id, tenantId);
    this.setAccessCookie(reply, newToken);
    return { active_tenant_id: tenantId };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: ReqWithCookies, @Res({ passthrough: true }) reply: FastifyReply) {
    const rawRefresh = req.cookies?.refresh_token;
    if (rawRefresh) {
      const tokenHash = this.security.hashRefreshToken(rawRefresh);
      await this.db.scoped(null, async (sql) => {
        await sql`
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      });
    }
    this.clearAuthCookies(reply);
    return { ok: true };
  }

  @Post('supabase-session')
  @HttpCode(200)
  async supabaseSession(
    @Body() body: SupabaseSessionDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    let claims;
    try {
      claims = await this.supabase.verifySupabaseToken(body.access_token);
    } catch {
      throw new HttpException({ detail: 'Invalid Supabase token' }, HttpStatus.UNAUTHORIZED);
    }
    const uid = await this.auth.ensureAppUser({ sub: claims.sub, email: claims.email as string });
    this.storeSupabaseSession(reply, body.access_token, body.refresh_token);
    if (uid) {
      await this.db.scoped(uid, async (sql) => {
        await auditLog(sql, uid, 'login', { entityType: 'user', entityId: uid, detail: 'supabase' });
      });
    }
    return { ok: true };
  }

  @Post('supabase-refresh')
  @HttpCode(200)
  async supabaseRefresh(
    @Req() req: ReqWithCookies,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const rt = req.cookies?.sb_refresh_token;
    if (!rt) {
      throw new HttpException({ detail: 'No Supabase refresh token' }, HttpStatus.UNAUTHORIZED);
    }
    let data;
    try {
      data = await this.supabase.refreshSession(rt);
    } catch {
      throw new HttpException({ detail: 'Supabase refresh failed' }, HttpStatus.UNAUTHORIZED);
    }
    this.storeSupabaseSession(reply, data.access_token, data.refresh_token);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Auth() user: CurrentUser) {
    const { tenants, isFundAdmin } = await this.auth.accessibleTenantsFor(user.user_id);
    const row = await this.db.scoped(user.user_id, async (sql) => {
      const rows = await sql`
        SELECT id, name, email, COALESCE(is_fund_viewer, false) AS is_fund_viewer
        FROM users WHERE id = ${user.user_id}
      `;
      return rows[0];
    });
    return {
      user: {
        id: String(row.id),
        name: row.name,
        email: row.email,
        is_fund_admin: isFundAdmin,
        is_fund_viewer: Boolean(row.is_fund_viewer),
      },
      accessible_tenants: tenants,
      active_tenant_id: user.active_tenant_id,
    };
  }
}
