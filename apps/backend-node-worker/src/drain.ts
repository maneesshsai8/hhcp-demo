/**
 * One-shot drain (CI / manual): process all currently-due events, print the
 * count, exit. Port of the Python `drain()` helper.
 *
 *   npm run drain -w @hhcp/backend-node-worker
 */
import postgres from 'postgres';
import { loadEnv, databaseUrl } from './env';
import { drain } from './worker';

loadEnv();

async function main(): Promise<void> {
  const sql = postgres(databaseUrl(), { max: 4 });
  try {
    const n = await drain(sql);
    // eslint-disable-next-line no-console
    console.log(n);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('drain crashed:', e);
  process.exit(1);
});
