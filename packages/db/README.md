# @hhcp/db — schema single source of truth

The numbered SQL migrations that define the entire HHCP database: RLS policies,
`SECURITY DEFINER` authorization functions (`user_accessible_tenants`,
`user_role_for_tenant`, `assignable_users`, …), declarative partitioning +
`pg_partman` + `pg_cron`, BRIN indexes, and the generated `tsvector` search
columns.

Both backends — the FastAPI reference app and the NestJS port — connect to the
**same** database with the **same** non-superuser `hhcp_app` role, so RLS applies
identically regardless of which backend answers a request. Neither backend owns
the schema; it lives here.

## Layout

- `migrations/` — the numbered `.sql` files, applied in filename order.
- `seeds/` — Python bootstrap/seed scripts (`seed.py`, `seed_hierarchy.py`,
  `migrate_users_to_supabase.py`). Data, not schema.

## Apply

```bash
DATABASE_URL=postgresql://hhcp_app:...@localhost:5432/hhcp_demo npm run apply -w @hhcp/db
# then seed:
python3 seeds/seed.py
```

> ⚠️ **Known numbering collisions** (`19_org_structure.sql` / `19_supabase_uid.sql`
> and `20_kpi_scores_partitioning.sql` / `20_lucid_embed.sql`) are applied in
> lexical order today. When adopting a real migration tool (`node-pg-migrate` /
> Drizzle Kit — see analysis §10), renumber these so ordering is unambiguous.
