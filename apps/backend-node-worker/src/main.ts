/**
 * Background-worker entrypoint. Run as a SEPARATE process from the API:
 *
 *   npm start -w @hhcp/backend-node-worker
 *
 * Faithful port of backend/app/workers/runner.py.
 */
import postgres from 'postgres';
import { loadEnv, databaseUrl } from './env';
import { runForever } from './worker';

loadEnv();

async function main(): Promise<void> {
  const sql = postgres(databaseUrl(), { max: 4 });
  try {
    await runForever(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('worker crashed:', e);
  process.exit(1);
});
