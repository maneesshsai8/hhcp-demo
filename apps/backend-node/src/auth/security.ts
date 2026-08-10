import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '../config/config.service';

/**
 * Password hashing, HS256 JWT issue/verify, and refresh-token generation.
 * Faithful port of backend/app/security.py.
 *
 * bcrypt hashes ($2a$/$2b$) are portable between the Python `bcrypt` lib and
 * `bcryptjs`, so existing password hashes verify unchanged. Refresh tokens are
 * stored only as SHA-256 hashes; the raw token goes to the client cookie.
 */

export interface AccessTokenClaims {
  user_id: string;
  active_tenant_id: string | null;
  iat?: number;
  exp?: number;
}

export class TokenExpiredError extends Error {}
export class InvalidTokenError extends Error {}

@Injectable()
export class SecurityService {
  constructor(private readonly config: ConfigService) {}

  verifyPassword(plain: string, passwordHash: string): boolean {
    return bcrypt.compareSync(plain, passwordHash);
  }

  hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, bcrypt.genSaltSync());
  }

  /**
   * Note what's deliberately NOT in here: no accessible_tenant_ids[] array.
   * Under Option B, authorization is re-checked against the live DB on every
   * request — the token only says who you are and which tenant you're
   * currently "standing inside."
   */
  createAccessToken(userId: string, activeTenantId: string | null): string {
    const payload: AccessTokenClaims = {
      user_id: String(userId),
      active_tenant_id: activeTenantId ? String(activeTenantId) : null,
    };
    return jwt.sign(payload, this.config.JWT_SECRET, {
      algorithm: this.config.JWT_ALGORITHM,
      expiresIn: this.config.ACCESS_TOKEN_LIFETIME_MINUTES * 60, // seconds
    });
  }

  /** Verify + decode. Throws TokenExpiredError / InvalidTokenError to mirror PyJWT. */
  decodeAccessToken(token: string): AccessTokenClaims {
    try {
      return jwt.verify(token, this.config.JWT_SECRET, {
        algorithms: [this.config.JWT_ALGORITHM],
      }) as AccessTokenClaims;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new TokenExpiredError((err as Error).message);
      }
      throw new InvalidTokenError((err as Error).message);
    }
  }

  /** Returns { raw, hash, expiresAt } — raw to the client, hash to the DB. */
  generateRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
    const raw = crypto.randomBytes(48).toString('base64url');
    const hash = this.hashRefreshToken(raw);
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_LIFETIME_DAYS * 24 * 3600 * 1000,
    );
    return { raw, hash, expiresAt };
  }

  hashRefreshToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
}
