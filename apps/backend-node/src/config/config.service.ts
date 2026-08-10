import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration. Mirrors backend/app/config.py: reads backend-node/.env when
 * present (so secrets stay out of the code), falling back to the same demo
 * defaults so a local run works with zero setup.
 *
 * Precedence matches Python's `os.environ.setdefault`: a real process env var
 * wins over a value in .env.
 */

const ACCESS_TOKEN_LIFETIME_MINUTES = 15;
const REFRESH_TOKEN_LIFETIME_DAYS = 14;

function loadDotenv(): void {
  const envPath = path.resolve(__dirname, '..', '..', '.env'); // backend-node/.env
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    // setdefault semantics: real env wins.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotenv();

@Injectable()
export class ConfigService {
  readonly DATABASE_URL =
    process.env.DATABASE_URL ??
    'postgresql://hhcp_app:demo_password_local_only@localhost:5432/hhcp_demo';

  // --- our own (local) JWT auth ---
  readonly JWT_SECRET =
    process.env.JWT_SECRET ?? 'demo-only-secret-do-not-use-in-production-1234567890';
  readonly JWT_ALGORITHM = 'HS256' as const;
  readonly ACCESS_TOKEN_LIFETIME_MINUTES = ACCESS_TOKEN_LIFETIME_MINUTES;
  readonly REFRESH_TOKEN_LIFETIME_DAYS = REFRESH_TOKEN_LIFETIME_DAYS;

  // --- authentication provider: 'local' (self-issued JWT) or 'supabase' ---
  readonly AUTH_PROVIDER = (process.env.AUTH_PROVIDER ?? 'local').toLowerCase();

  readonly PORT = parseInt(process.env.PORT ?? '8001', 10);

  // --- Supabase ---
  readonly SUPABASE_URL = process.env.SUPABASE_URL || undefined;
  readonly SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || undefined;
  readonly SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || undefined;
  readonly SUPABASE_JWKS_URL =
    process.env.SUPABASE_JWKS_URL ||
    (this.SUPABASE_URL ? `${this.SUPABASE_URL}/auth/v1/.well-known/jwks.json` : undefined);
  // Set for LOCAL Supabase (HS256 shared secret); unset → hosted (ES256/JWKS).
  readonly SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || undefined;

  // --- Lucidchart token-based embeds (Approach 2) ---
  // Mirrors backend/app/config.py: the OAuth creds are obtained once via the
  // helper and live only in .env (unset → the embed-session endpoint reports
  // `configured: false` instead of erroring). API version + embed origin have
  // the same demo defaults as Python.
  readonly LUCID_CLIENT_ID = process.env.LUCID_CLIENT_ID || undefined;
  readonly LUCID_CLIENT_SECRET = process.env.LUCID_CLIENT_SECRET || undefined;
  readonly LUCID_REFRESH_TOKEN = process.env.LUCID_REFRESH_TOKEN || undefined; // obtained once via the OAuth helper
  readonly LUCID_API_VERSION = process.env.LUCID_API_VERSION ?? '1';
  readonly LUCID_EMBED_ORIGIN = process.env.LUCID_EMBED_ORIGIN ?? 'http://localhost:3002';

  // --- SMTP (demo → local Supabase Mailpit catcher; view at :54324) ---
  // Mirrors backend/app/config.py: best-effort email for announcement fan-out.
  readonly SMTP_HOST = process.env.SMTP_HOST ?? '127.0.0.1';
  readonly SMTP_PORT = parseInt(process.env.SMTP_PORT ?? '54325', 10);
  readonly SMTP_FROM = process.env.SMTP_FROM ?? 'announcements@hhcp.local';

  // --- Calendar sync (scaffolded; unset → CalendarNotConfigured) ---
  readonly GOOGLE_CALENDAR_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || undefined;
  readonly GOOGLE_CALENDAR_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || undefined;
  readonly GOOGLE_CALENDAR_REFRESH_TOKEN = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || undefined;
  readonly MS_CALENDAR_CLIENT_ID = process.env.MS_CALENDAR_CLIENT_ID || undefined;
  readonly MS_CALENDAR_CLIENT_SECRET = process.env.MS_CALENDAR_CLIENT_SECRET || undefined;
  readonly MS_CALENDAR_REFRESH_TOKEN = process.env.MS_CALENDAR_REFRESH_TOKEN || undefined;
}
