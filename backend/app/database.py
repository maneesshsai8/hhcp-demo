"""
Owns the asyncpg connection pool, plus the one function that matters most in
this whole demo: get_scoped_connection().

Every business-logic query in this app goes through that function. It opens
a transaction and runs `SET LOCAL app.current_user_id = ...` exactly once,
scoped to that request. From that point on, every plain, unfiltered SQL
query on this connection is automatically scoped by Postgres's own RLS
policies (see database/01_schema.sql) — the application code never writes
`WHERE tenant_id = ...` anywhere. That's the whole point of Option B.
"""
import contextlib
from typing import Optional

import asyncpg

from app.config import DATABASE_URL

_pool: Optional[asyncpg.Pool] = None


async def create_pool():
    global _pool
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)


async def close_pool():
    if _pool:
        await _pool.close()


def pool():
    """The raw connection pool (no RLS context) — for identity lookups that
    aren't tenant-scoped, e.g. mapping a Supabase sub to our users.id."""
    return _pool


@contextlib.asynccontextmanager
async def get_scoped_connection(user_id: Optional[str]):
    """
    Yields a connection whose current transaction has app.current_user_id
    set to `user_id`. If user_id is None (e.g. an unauthenticated request
    that slipped through), RLS's default-deny behavior means every query
    simply returns zero rows — never an error, never a leak.

    SET LOCAL scopes the setting to this transaction only, so it can never
    leak into the next request that happens to reuse this pooled connection.
    """
    async with _pool.acquire() as conn:
        async with conn.transaction():
            if user_id is not None:
                await conn.execute("SELECT set_config('app.current_user_id', $1, true)", str(user_id))
            yield conn
