import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal .env loader with setdefault semantics (real env wins) — same behavior
 * as apps/backend-node/src/config/config.service.ts, so the worker reads the
 * same conventions without pulling in Nest.
 */
export function loadEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    'postgresql://hhcp_app:demo_password_local_only@localhost:5432/hhcp_demo'
  );
}
