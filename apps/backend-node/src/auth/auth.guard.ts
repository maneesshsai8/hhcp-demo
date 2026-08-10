import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { CurrentUser } from './current-user';
import { InvalidTokenError, SecurityService, TokenExpiredError } from './security';
import { SupabaseAuthService } from './supabase-auth';

type ReqWithCookies = FastifyRequest & {
  cookies?: Record<string, string | undefined>;
  currentUser?: CurrentUser;
};

/**
 * Proves identity per request. Faithful port of dependencies.get_current_user.
 * Does NOT decide authorization — that's RLS + the permissions matrix downstream.
 *
 * Attach with `@UseGuards(AuthGuard)`; read the principal with `@Auth()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly security: SecurityService,
    private readonly supabase: SupabaseAuthService,
  ) {}

  private unauthorized(detail: string): never {
    throw new HttpException({ detail }, HttpStatus.UNAUTHORIZED);
  }

  private forbidden(detail: string): never {
    throw new HttpException({ detail }, HttpStatus.FORBIDDEN);
  }

  /** httpOnly cookie first, Authorization: Bearer header as fallback. */
  private extractToken(req: ReqWithCookies): string {
    let token = req.cookies?.access_token;
    if (!token) {
      const authz = (req.headers['authorization'] as string) ?? '';
      if (authz.startsWith('Bearer ')) token = authz.slice('Bearer '.length).trim();
    }
    if (!token) this.unauthorized('Not authenticated');
    return token;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ReqWithCookies>();
    const token = this.extractToken(req);

    if (this.config.AUTH_PROVIDER === 'supabase') {
      let claims;
      try {
        claims = await this.supabase.verifySupabaseToken(token);
      } catch {
        this.unauthorized('Invalid or expired Supabase token');
      }
      const sub = claims.sub;
      const rows = await this.db
        .unscoped`SELECT id, is_active FROM users WHERE supabase_uid = ${String(sub)}::uuid`;
      const row = rows[0];
      if (!row) this.forbidden('No app user is linked to this Supabase account');
      if (!row.is_active) this.forbidden('This account has been deactivated');
      // Active tenant isn't in the Supabase token — it's separate app state.
      const active =
        req.cookies?.active_tenant_id ||
        (req.headers['x-active-tenant'] as string | undefined) ||
        null;
      req.currentUser = new CurrentUser(String(row.id), active || null);
      return true;
    }

    // --- local provider (default) ---
    let payload;
    try {
      payload = this.security.decodeAccessToken(token);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        this.unauthorized('Access token expired — use /auth/refresh');
      }
      if (err instanceof InvalidTokenError) {
        this.unauthorized('Invalid access token');
      }
      throw err;
    }

    // Deactivation takes effect on the very next request (like a revoked grant).
    const rows = await this.db
      .unscoped`SELECT is_active FROM users WHERE id = ${payload.user_id}`;
    if (rows[0]?.is_active === false) {
      this.forbidden('This account has been deactivated');
    }

    req.currentUser = new CurrentUser(payload.user_id, payload.active_tenant_id ?? null);
    return true;
  }
}
