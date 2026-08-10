import { Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  JWTPayload,
  decodeJwt,
} from 'jose';
import { ConfigService } from '../config/config.service';

/**
 * Supabase token verification + refresh. Faithful port of
 * backend/app/supabase_auth.py.
 *
 *  - LOCAL Supabase CLI signs HS256 with a shared secret (SUPABASE_JWT_SECRET).
 *  - HOSTED Supabase signs ES256 and publishes a JWKS (verified via the
 *    well-known JWKS URL, with key caching handled by createRemoteJWKSet).
 *
 * Fixes a latent bug in the Python version: refresh_session used a *blocking*
 * urllib call inside an async app; here it is a natural async fetch.
 */
@Injectable()
export class SupabaseAuthService {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService) {}

  private getJwks() {
    if (!this.jwks) {
      if (!this.config.SUPABASE_JWKS_URL) {
        throw new Error('SUPABASE_JWKS_URL is not configured');
      }
      this.jwks = createRemoteJWKSet(new URL(this.config.SUPABASE_JWKS_URL));
    }
    return this.jwks;
  }

  async verifySupabaseToken(token: string): Promise<JWTPayload> {
    const issuer = this.config.SUPABASE_URL
      ? `${this.config.SUPABASE_URL}/auth/v1`
      : undefined;

    if (this.config.SUPABASE_JWT_SECRET) {
      // Local Supabase CLI: symmetric HS256.
      const key = new TextEncoder().encode(this.config.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience: 'authenticated',
        issuer,
      });
      return payload;
    }

    // Hosted Supabase: asymmetric ES256 via JWKS.
    const { payload } = await jwtVerify(token, this.getJwks(), {
      algorithms: ['ES256'],
      audience: 'authenticated',
      issuer,
    });
    return payload;
  }

  /** Decode without verifying — used only to size a cookie's max-age (never a security decision). */
  unverifiedExp(token: string): number {
    try {
      return decodeJwt(token).exp ?? 0;
    } catch {
      return 0;
    }
  }

  async refreshSession(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
    if (!this.config.SUPABASE_URL || !this.config.SUPABASE_ANON_KEY) {
      throw new Error('Supabase is not configured');
    }
    const res = await fetch(
      `${this.config.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          apikey: this.config.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
    );
    if (!res.ok) throw new Error(`Supabase refresh failed (${res.status})`);
    return (await res.json()) as { access_token: string; refresh_token: string };
  }
}
