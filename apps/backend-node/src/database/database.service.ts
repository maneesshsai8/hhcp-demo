import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import postgres, { Sql, TransactionSql } from 'postgres';
import { ConfigService } from '../config/config.service';

/**
 * Owns the postgres.js connection pool, plus the one function that matters most
 * in this whole system: `scoped()` — the faithful port of the Python app's
 * `get_scoped_connection()` (backend/app/database.py).
 *
 * Every business-logic query goes through `scoped()`. It opens a transaction and
 * runs `SET LOCAL app.current_user_id = ...` exactly once, scoped to that
 * request. From that point on, every plain, unfiltered SQL query on the
 * transaction handle is automatically scoped by Postgres's own RLS policies
 * (database/01_schema.sql) — the application code never writes
 * `WHERE tenant_id = ...` anywhere. That is Option B, and it is the entire
 * security model. If this idiom is wrong, RLS silently returns empty or leaks
 * across tenants; if it is right, isolation is free on every query.
 *
 * `SET LOCAL` scopes the setting to the transaction only, so it can never leak
 * into the next request that happens to reuse this pooled connection.
 *
 * An AsyncLocalStorage carries the active transaction handle through the call
 * stack, so guards/services can reach "the current request's scoped connection"
 * without threading it through every function signature.
 */

/** The transaction-bound tagged-template query function (postgres.js). */
export type ScopedSql = TransactionSql;

interface ScopeStore {
  sql: ScopedSql;
  userId: string | null;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private sql!: Sql;
  private readonly als = new AsyncLocalStorage<ScopeStore>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // min/max mirror the Python asyncpg pool (min_size=1, max_size=10).
    this.sql = postgres(this.config.DATABASE_URL, {
      max: 10,
      types: {
        // Postgres bigint (int8, OID 20) — e.g. every count(*) — must come back as
        // a JS number so JSON has `"member_count": 3`, matching asyncpg+FastAPI.
        // postgres.js would otherwise return it as a string. Counts here are small,
        // so Number() is safe.
        bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
        // Postgres date (OID 1082) — return the raw 'YYYY-MM-DD' text instead of a
        // JS Date, so date columns serialize exactly like Pydantic's `date`
        // ('2026-08-07'), not a full ISO timestamp. (timestamptz stays a Date.)
        dateText: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sql) await this.sql.end({ timeout: 5 });
  }

  /**
   * The raw pool with NO RLS context — for identity lookups that aren't
   * tenant-scoped, e.g. checking `users.is_active` or mapping a Supabase `sub`
   * to our `users.id`. Mirrors Python's `database.pool()`.
   */
  get unscoped(): Sql {
    return this.sql;
  }

  /**
   * Run `fn` inside a transaction whose `app.current_user_id` is set to
   * `userId`. If `userId` is null (an unauthenticated/identity query), nothing
   * is set and RLS default-deny returns zero rows — never an error, never a
   * leak. Faithful port of `async with get_scoped_connection(user_id) as conn`.
   */
  async scoped<T>(userId: string | null, fn: (sql: ScopedSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      if (userId != null) {
        // Positional-safe: postgres.js parameterizes the interpolation.
        await tx`SELECT set_config('app.current_user_id', ${String(userId)}, true)`;
      }
      return this.als.run({ sql: tx, userId }, () => fn(tx));
    }) as Promise<T>;
  }

  /**
   * The scoped connection for the current async context, if `scoped()` is on the
   * stack. Lets code deep in a request reach the same transaction handle.
   */
  get current(): ScopedSql | undefined {
    return this.als.getStore()?.sql;
  }
}
