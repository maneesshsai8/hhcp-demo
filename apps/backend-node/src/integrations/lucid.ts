import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

/**
 * Lucidchart token-based embeds (Approach 2). Faithful port of
 * backend/app/lucid.py — Python's httpx.AsyncClient calls become Node's global
 * fetch (no npm deps).
 *
 * The whole point: viewers see the chart WITHOUT a Lucid account and never hit a
 * login prompt, because our backend mints a short-lived embed session token using
 * OAuth credentials that never leave the server.
 *
 * Flow (per Lucid's Embed API — https://developer.lucid.co/docs/tutorial-token-embeds):
 *   1. refresh_token (stored in .env, obtained once via scripts/lucid_oauth.py)
 *      --> access_token          POST https://api.lucid.co/oauth2/token
 *   2. access_token + embedId    --> short-lived embed session token
 *                                POST https://api.lucid.co/embeds/token
 *   3. iframe src = https://lucid.app/embeds?token=<session token>
 *
 * Tokens are single-use / short-lived, so we mint a fresh one on every view.
 */

const OAUTH_TOKEN_URL = 'https://api.lucid.co/oauth2/token';
const EMBED_TOKEN_URL = 'https://api.lucid.co/embeds/token';
const EMBED_IFRAME_BASE = 'https://lucid.app/embeds';

// httpx's raise_for_status() throws on any 4xx/5xx; fetch does not, so we mirror
// it explicitly. The resulting error propagates exactly like the Python one
// (caught by the /seats/embed-session handler and surfaced as a 502).
async function raiseForStatus(resp: Response, context: string): Promise<void> {
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`${context}: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`);
  }
}

@Injectable()
export class LucidService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.LUCID_CLIENT_ID && this.config.LUCID_CLIENT_SECRET && this.config.LUCID_REFRESH_TOKEN,
    );
  }

  /** Exchange the stored refresh token for a fresh access token. */
  private async accessToken(): Promise<string> {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.config.LUCID_REFRESH_TOKEN,
        client_id: this.config.LUCID_CLIENT_ID,
        client_secret: this.config.LUCID_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(15000),
    });
    await raiseForStatus(resp, 'Lucid OAuth token request failed');
    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Lucid OAuth token response missing access_token');
    }
    return data.access_token;
  }

  private extractToken(payload: Record<string, unknown>): string | null {
    // the docs don't pin the field name, so accept the common shapes
    for (const k of ['token', 'sessionToken', 'embedSessionToken', 'embed_session_token']) {
      const v = payload[k];
      if (v) return String(v);
    }
    return null;
  }

  /** Return a ready-to-iframe URL carrying a fresh short-lived session token. */
  async mintEmbedUrl(embedId: string): Promise<string> {
    const access = await this.accessToken();
    const resp = await fetch(EMBED_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Lucid-Api-Version': this.config.LUCID_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: this.config.LUCID_EMBED_ORIGIN, embedId }),
      signal: AbortSignal.timeout(15000),
    });
    await raiseForStatus(resp, 'Lucid embed token request failed');
    const token = this.extractToken((await resp.json()) as Record<string, unknown>);
    if (!token) {
      throw new Error('Lucid embed token endpoint returned no token field');
    }
    return `${EMBED_IFRAME_BASE}?token=${token}`;
  }
}
