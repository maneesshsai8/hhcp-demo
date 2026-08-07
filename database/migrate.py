#!/usr/bin/env python3
"""
Thin, forward-only migration runner over the existing database/NN_*.sql files.

Why not Alembic/Flyway: this schema's value is raw-SQL RLS policies, SECURITY
DEFINER functions, and pg_partman/pg_cron partitioning — none of which an ORM
autogenerator can see or diff. So the migrations ARE hand-written SQL either way.
What was missing is *tracking*: which files have been applied, in what order, and
whether an already-applied file was later edited (drift). This adds exactly that.

What it gives you:
  * schema_migrations table  — filename | checksum | applied_at | applied_by
  * deterministic order       — sorted by full filename (handles the duplicate
                                19_/20_ numbers unambiguously)
  * checksum drift detection  — refuses to proceed if an APPLIED file's bytes
                                changed (someone edited history)
  * one-shot guard            — the non-idempotent structural conversions
                                (partitioning) are never auto-applied blind
  * CI-from-zero              — `apply` on an empty DB reproduces the schema, so
                                the isolation conformance test runs against a
                                known-good database

Commands:
  status    show applied / pending / drifted per file (your dev=35/staging=34 map)
  apply     run every pending file in order, each in its own transaction, record it
  backfill  record all files as applied WITHOUT running them (adopt an existing DB)

Connection: migrations create policies/grants, so they need a privileged role
(the table owner / superuser), NOT hhcp_app. Set MIGRATE_DATABASE_URL, else it
defaults to the local Supabase superuser DSN.
"""
import asyncio
import hashlib
import os
import sys
from pathlib import Path

import asyncpg

MIGRATIONS_DIR = Path(__file__).resolve().parent
DSN = os.getenv("MIGRATE_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/hhcp_demo")

# Non-idempotent, run-once structural conversions. They rename tables and depend
# on pg_partman/pg_cron; never auto-apply them from `apply` without an explicit
# --run-one-shots (a fresh CI DB without those extensions marks them skipped).
ONE_SHOT = {
    "20_kpi_scores_partitioning.sql",
    "32_notification_deliveries_partition.sql",
}

BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by  TEXT NOT NULL DEFAULT current_user
);
"""


def _files() -> list[Path]:
    # sorted by full filename → deterministic even when numbers collide (19_/20_)
    return sorted(MIGRATIONS_DIR.glob("[0-9]*.sql"), key=lambda p: p.name)


def _checksum(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


async def _applied(conn) -> dict[str, str]:
    rows = await conn.fetch("SELECT filename, checksum FROM schema_migrations")
    return {r["filename"]: r["checksum"] for r in rows}


async def cmd_status(conn):
    applied = await _applied(conn)
    files = _files()
    pending = drift = 0
    print(f"{'STATUS':10} {'FILE':<44} note")
    print("-" * 78)
    for p in files:
        name, cs = p.name, _checksum(p)
        if name not in applied:
            state, note = "PENDING", "one-shot" if name in ONE_SHOT else ""
            pending += 1
        elif applied[name] != cs:
            state, note, drift = "DRIFT", "applied file was edited since!", drift + 1
        else:
            state, note = "applied", ""
        print(f"{state:10} {name:<44} {note}")
    print("-" * 78)
    print(f"{len(files)} files · {len(files) - pending} applied · {pending} pending · {drift} drifted")
    if drift:
        print("\n⚠  DRIFT: an already-applied migration's contents changed. History is "
              "immutable — write a NEW migration instead of editing an old one.")
    return drift


async def _apply_file(conn, p: Path, *, run: bool):
    """Apply one file in a transaction and record it. run=False just records it."""
    async with conn.transaction():
        if run:
            # asyncpg runs a multi-statement script (DO blocks, $$ bodies and all)
            # via the simple-query protocol when no args are passed.
            await conn.execute(p.read_text())
        await conn.execute(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) "
            "ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()",
            p.name, _checksum(p),
        )


async def cmd_apply(conn, run_one_shots: bool):
    applied = await _applied(conn)
    # fail fast on drift before changing anything
    for p in _files():
        if p.name in applied and applied[p.name] != _checksum(p):
            print(f"✗ DRIFT on {p.name} — applied contents changed. Aborting. "
                  f"Write a new migration instead of editing history.")
            return 1
    ran = skipped = 0
    for p in _files():
        if p.name in applied:
            continue
        if p.name in ONE_SHOT and not run_one_shots:
            print(f"↷ skip (one-shot) {p.name}  — pass --run-one-shots to apply")
            skipped += 1
            continue
        print(f"→ applying {p.name}")
        await _apply_file(conn, p, run=True)
        ran += 1
    print(f"\n✓ applied {ran} migration(s); {skipped} one-shot(s) skipped")
    return 0


async def cmd_backfill(conn):
    """Record every file as applied WITHOUT running it — adopt an already-migrated DB."""
    applied = await _applied(conn)
    n = 0
    for p in _files():
        if p.name not in applied:
            await _apply_file(conn, p, run=False)
            n += 1
    print(f"✓ backfilled {n} file(s) as applied (nothing was executed); "
          f"{len(_files())} tracked total")
    return 0


async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    conn = await asyncpg.connect(DSN)
    try:
        await conn.execute(BOOTSTRAP)
        if cmd == "status":
            rc = await cmd_status(conn)
            sys.exit(1 if rc else 0)
        elif cmd == "apply":
            sys.exit(await cmd_apply(conn, run_one_shots="--run-one-shots" in sys.argv))
        elif cmd == "backfill":
            sys.exit(await cmd_backfill(conn))
        else:
            print(f"unknown command: {cmd}\nusage: migrate.py [status|apply|backfill] [--run-one-shots]")
            sys.exit(2)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
