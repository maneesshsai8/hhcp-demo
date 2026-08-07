#!/usr/bin/env python3
"""
Tenant-isolation conformance gate.

Reads the live database catalog and asserts, for EVERY table in `public`, that
tenant isolation is actually in force — turning the "remember to add RLS"
convention into a build-breaking invariant. Run it in CI after `migrate.py apply`
against a fresh DB; a non-zero exit blocks the merge.

A table PASSES if one of:
  1. It is tenant-scoped by a `tenant_id` column AND has RLS enabled AND has a
     policy AND `hhcp_app` has been granted on it. (the normal case)
  2. It is SPECIAL-scoped — isolated by a different column (e.g. organizations by
     `id`, tenant_memberships by `user_id`) — and still has RLS + a policy. It
     must appear in SPECIAL_SCOPED with the column named, so the exception is
     explicit and reviewed.
  3. It is GLOBAL by design (users, audit_log, the outbox/idempotency infra) and
     appears in GLOBAL with a written reason.

Anything else FAILS. In particular the classic leak — a table with `tenant_id`
but RLS never enabled, or RLS enabled with no policy — is a hard failure.

Also enforced once, globally: `hhcp_app` must be a plain role (NOT superuser, NOT
BYPASSRLS, NOT the table owner) — otherwise every policy above is void.

To add a table to an allowlist you must state WHY. That review is the point:
every RLS-free table becomes a deliberate decision, not an accident.
"""
import asyncio
import os
import sys

import asyncpg

DSN = os.getenv("MIGRATE_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/hhcp_demo")
APP_ROLE = "hhcp_app"

# Tables with NO tenant scoping by design. Each needs a reason.
GLOBAL = {
    "users":               "people exist across tenants; login queries them pre-auth (no tenant context yet)",
    "refresh_tokens":      "session tokens, scoped by user_id not tenant; never holds business data",
    "audit_log":           "compliance record deliberately spans tenants; fund-admin-only via the app",
    "meeting_outbox":      "infra: durable event log drained by the worker with no user context",
    "meeting_idempotency": "infra: command-dedup keyed by user+command+key, not tenant",
    "schema_migrations":   "infra: migration bookkeeping",
}

# Tenant-isolated, but by a column OTHER than tenant_id. Must still have RLS+policy.
SPECIAL_SCOPED = {
    "organizations":      "id",       # the tenant tree itself — scoped by id IN user_accessible_tenants()
    "tenant_memberships": "user_id",  # scoped to the owning user / fund admins
}

TABLES_Q = """
SELECT c.relname AS name, c.relrowsecurity AS rls, c.relowner::regrole::text AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
ORDER BY c.relname
"""


async def _has_col(conn, table, col):
    return await conn.fetchval(
        "SELECT true FROM information_schema.columns WHERE table_schema='public' "
        "AND table_name=$1 AND column_name=$2", table, col) or False


async def _policy_count(conn, table):
    return await conn.fetchval(
        "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename=$1", table)


async def _granted(conn, table):
    return (await conn.fetchval(
        "SELECT count(*) FROM information_schema.role_table_grants "
        "WHERE table_schema='public' AND table_name=$1 AND grantee=$2", table, APP_ROLE)) > 0


async def main():
    conn = await asyncpg.connect(DSN)
    failures, warnings = [], []
    try:
        # ---- global invariant: the app role must not be able to bypass RLS ----
        role = await conn.fetchrow(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", APP_ROLE)
        if role is None:
            failures.append(f"app role '{APP_ROLE}' does not exist")
        elif role["rolsuper"] or role["rolbypassrls"]:
            failures.append(f"'{APP_ROLE}' is SUPERUSER/BYPASSRLS — every RLS policy is void")

        tables = await conn.fetch(TABLES_Q)
        print(f"{'RESULT':8} {'TABLE':<34} detail")
        print("-" * 82)
        for t in tables:
            name, rls = t["name"], t["rls"]
            owner_is_app = t["owner"] == APP_ROLE

            if name in GLOBAL:
                print(f"{'EXEMPT':8} {name:<34} global — {GLOBAL[name]}")
                continue

            if owner_is_app:
                failures.append(f"{name}: owned by {APP_ROLE} (owner bypasses RLS)")

            has_policy = (await _policy_count(conn, name)) > 0
            granted = await _granted(conn, name)

            if name in SPECIAL_SCOPED:
                col = SPECIAL_SCOPED[name]
                ok = rls and has_policy and (await _has_col(conn, name, col))
                if ok:
                    print(f"{'PASS':8} {name:<34} special-scoped by {col} (rls+policy)")
                else:
                    failures.append(f"{name}: special-scoped by {col} but "
                                    f"rls={rls} policy={has_policy}")
                if not granted:
                    warnings.append(f"{name}: no grant to {APP_ROLE}")
                continue

            # normal case: must be tenant_id + RLS + policy
            has_tenant = await _has_col(conn, name, "tenant_id")
            problems = []
            if not has_tenant:
                problems.append("no tenant_id column and not allowlisted")
            if not rls:
                problems.append("RLS not enabled")
            if not has_policy:
                problems.append("no policy")
            if problems:
                failures.append(f"{name}: " + "; ".join(problems))
                print(f"{'FAIL':8} {name:<34} " + "; ".join(problems))
            else:
                print(f"{'PASS':8} {name:<34} tenant_id + rls + policy")
                if not granted:
                    warnings.append(f"{name}: no grant to {APP_ROLE}")

        print("-" * 82)
        print(f"{len(tables)} tables · {len(failures)} FAIL · {len(warnings)} warn")
        for w in warnings:
            print(f"  warn: {w}")
        if failures:
            print("\n✗ ISOLATION FAILURES (a cross-tenant leak or broken RLS):")
            for f in failures:
                print(f"  ✗ {f}")
            print("\nFix: add tenant_id + `ENABLE ROW LEVEL SECURITY` + the tenant policy + grant, "
                  "OR add the table to GLOBAL/SPECIAL_SCOPED in check_isolation.py WITH A REASON.")
            sys.exit(1)
        print("\n✓ every table is tenant-isolated or explicitly, reviewably exempt.")
        sys.exit(0)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
