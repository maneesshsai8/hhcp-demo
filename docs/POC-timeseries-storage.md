# POC Analysis: Supabase Time-Series Storage for Immutable Scorecard KPI History

> **Status:** Analysis & planning only. No implementation, migrations, schema
> changes, SQL, API, or frontend code is included or intended here.
> Implementation will be requested separately after this plan is approved.
>
> **Verification update (2026-08-05):** the §2 spike has been run against the live
> Supabase project — **TimescaleDB is confirmed unavailable**; `pg_partman` +
> `pg_cron` (the alternative stack) are confirmed present. See §2 and §11.
>
> **Implementation status (2026-08-05):** Plan A (§11) is implemented as
> `database/20_kpi_scores_partitioning.sql` — monthly `RANGE` partitioning +
> `pg_partman` 5.3.1 + `pg_cron` + BRIN, preserving the append-only contract, PK,
> and RLS. **Applied and validated on the local `hhcp_demo` DB (Postgres 16.10)**;
> `pg_cron` + `pg_partman` were built from source into the Homebrew PG16.
> Verified: table is partitioned with 9 monthly children + default; 24 legacy
> rows backfilled; indexes (PK/BRIN/tenant) cascade to children; partition
> pruning confirmed via `EXPLAIN`; RLS default-deny (0 rows without context) and
> scoped visibility both hold for the `hhcp_app` role; app-role `INSERT` routes to
> the correct monthly partition. No backend or frontend change was needed.
>
> Two fixes were folded in during validation: (1) rename the legacy table's
> indexes on conversion (index names are schema-scoped and collided), and
> (2) re-grant table privileges to the app role after recreation (a superuser-
> recreated table doesn't inherit grants). The legacy table is retained; run
> step 8 to drop it once satisfied.
>
> **Supabase deployment (2026-08-05):** the full stack is now live on the Supabase
> project (`tozmtpohsetpzyzwmudv`, ap-northeast-1). Bootstrap order: created role
> `hhcp_app`, ran base migrations `01`–`19`, ran migration 20, loaded seed data.
> On Supabase `pg_partman` (and `pg_cron`) are preinstalled in the **`extensions`**
> schema, not `partman`, so migration 20 was run through a schema-substituted
> variant (`partman.` → `extensions.`); the committed file still targets the
> local `partman` schema. Verified: `kpi_scores` partitioned, 24 seed rows routed
> to the Jun/Jul-2026 partitions, BRIN + RLS + `pg_cron` job present, and the
> `hhcp_app` role connects via the pooler with RLS enforcing (0 rows without
> context, tenant-scoped with it). Follow-up: make the committed migration
> schema-portable (resolve the pg_partman schema dynamically) so one file works on
> both environments.

---

## ⚠️ Two findings that reframe the whole request

**1. There is no Prisma in this codebase.** The backend is **FastAPI + `asyncpg` +
raw SQL migrations** (`backend/requirements.txt`, `backend/app/database.py`).
Migrations are hand-numbered `.sql` files applied via `psql`
(`database/01_schema.sql` … `database/19_supabase_uid.sql`), not an ORM. Every
"Prisma compatibility / Prisma schema / Prisma migration" item in the brief has
**no target in this repo**. Each of those is reinterpreted below as
"asyncpg + raw-SQL". If a Prisma migration is genuinely planned (e.g. a separate
service), this doc's Prisma sections must be redone.

**2. The immutable-KPI-history POC is already built and working.**
`backend/app/routers/scorecards.py` + the `kpi_scores` table already satisfy
*every* Phase-2 success criterion, on a plain indexed Postgres table:

| POC requirement | Already implemented |
|---|---|
| Immutable historical storage | `kpi_scores` is **INSERT-only**; nothing in the codebase `UPDATE`s or `DELETE`s a score |
| Append-only KPI records | `_record_score()` (`scorecards.py:252`) only ever `INSERT`s |
| Editing a KPI doesn't rewrite the past | `update_kpi()` touches only `kpis`, never `kpi_scores` (`scorecards.py:199`) |
| Time-based querying | `WHERE kpi_id = $1 ORDER BY recorded_at` throughout |
| Latest KPI retrieval | `ORDER BY recorded_at DESC LIMIT 1/13` (`scorecards.py:120`) |
| Historical trend retrieval | `weekly_history` built chronologically for charting (`scorecards.py:165`) |

The `kpi_scores` schema — PK `(kpi_id, recorded_at)`, `tenant_id` FK,
`recorded_at TIMESTAMPTZ`, RLS-enabled (`01_schema.sql:86-198`) — is a textbook
append-only time-series table. `README.md` and `ARCHITECTURE-GAPS.md` already
record the deliberate decision: *"this demo uses neither [TimescaleDB nor
partitioning]… TimescaleDB's hosted-extension availability was explicitly flagged
as needs verification."*

**So the real question isn't "can we build immutable KPI history" — it's "does
this table need TimescaleDB or partitioning to be production-ready at scale, and
does Supabase even allow TimescaleDB?"** That is what the rest of this document
answers.

---

## 1. Feasibility Analysis — TimescaleDB on Supabase

**Do not assume it's available — and the strong read is that it is not a safe
dependency.** Based on how managed Supabase is configured (knowledge as of early
2026 — must be verified against *your* project, see §2):

| Factor | Assessment |
|---|---|
| **Availability** | Historically Supabase shipped only the **Apache-2 licensed** build of TimescaleDB, and has since **deprecated/removed it for new projects**. Treat as *likely unavailable*; if present, likely on borrowed time. |
| **Installation** | `timescaledb` requires being in `shared_preload_libraries`. On managed Supabase you **cannot edit** `shared_preload_libraries` yourself — it only works if Supabase pre-loaded it. So it's binary: the dashboard / `pg_available_extensions` offers it, or you cannot add it at all (no superuser). |
| **Feature ceiling** | The Apache-2 build **excludes compression and continuous aggregates** — the two features that actually justify TimescaleDB at scale. You'd get hypertables + `time_bucket()` but not the columnar/rollup wins. |
| **Prisma compat** | N/A here (no Prisma). *Even in general*, Prisma doesn't model hypertables, `create_hypertable()`, or retention policies — you manage those in raw SQL / `$executeRaw` outside the ORM. |
| **RLS compat** | RLS works on hypertables, but policies must be authored so they propagate to chunks; the `SET LOCAL app.current_user_id` + `current_setting()` pattern (`database.py:52`) is compatible but needs re-verification per-chunk. Added surface area. |
| **Backup/migration** | `pg_dump` / PITR handling of hypertables is non-trivial; Supabase's managed backup + branching may not cleanly restore hypertable chunk metadata. A real vendor-lock and DR risk. |

**Conclusion:** TimescaleDB is neither confirmed available nor, in its
Supabase-available form, worth the operational and lock-in cost for this workload.

---

## 2. TimescaleDB Support Verification Approach (the actual spike)

This is a **read-only investigation** — no schema changes. Run against the real
Supabase project (its DB is what `backend/.env` points at):

1. **Is it even offered?**
   `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name LIKE 'timescale%';`
   — empty result ⇒ not available, stop here, go to §3.
2. **Which edition/license?** If offered, check whether it's `apache` or
   `timescaledb` (TSL). Apache-only ⇒ no compression / continuous aggregates.
3. **Can it actually be enabled?** In a **throwaway Supabase branch/project**, try
   `CREATE EXTENSION IF NOT EXISTS timescaledb;` — a `shared_preload_libraries`
   error confirms you can't self-install.
4. **Dashboard check:** Supabase Dashboard → Database → Extensions → search
   "timescale". Presence of the toggle is the authoritative signal.
5. **Permissions:** confirm the app role vs `postgres` / `supabase_admin` —
   extension creation needs the privileged role, which app connections don't use.
6. **DR check:** if available, take a `pg_dump` of a trivial hypertable and confirm
   restore into a fresh project succeeds.

Deliverable of the spike: a one-page yes/no with the `pg_available_extensions`
output pasted in.

### ✅ VERIFIED (2026-08-05) — spike run against the live project

`SELECT name, default_version FROM pg_available_extensions ORDER BY name;` was run
against the real Supabase project (ref `tozmtpohsetpzyzwmudv`, region
**ap-northeast-1**). Result: **78 extensions, and `timescaledb` is NOT among them.**

**Conclusion: Option A (TimescaleDB) is definitively unavailable on this project** —
`CREATE EXTENSION timescaledb` is impossible; it is not offered. This settles §1
empirically; no throwaway-branch test (step 3) is needed.

**Every building block for the Supabase-native alternative (§11) IS present:**

| Needed for | Extension | Version | Present |
|---|---|---|---|
| Partition automation + retention | `pg_partman` | 5.3.1 | ✅ |
| Scheduling (cron, matview refresh) | `pg_cron` | 1.6.4 | ✅ |
| Lock-light table rewrite (migration) | `pg_repack` | 1.5.2 | ✅ (bonus) |
| Benchmark index tuning (BRIN vs btree) | `hypopg` + `index_advisor` | 1.4.1 / 0.2.0 | ✅ (bonus) |

**Connection note (operational):** the direct host `db.<ref>.supabase.co:5432` is
**IPv6-only** and was unreachable from an IPv4-only machine. The spike had to use
the **Supavisor pooler** — `aws-0-ap-northeast-1.pooler.supabase.com:5432`, user
`postgres.<ref>`, `sslmode=require`. Any future scripts/CI on IPv4-only networks
must use the pooler, not the direct host.

---

## 3. Fallback Analysis — PostgreSQL Native Partitioning

Native declarative partitioning (`PARTITION BY RANGE (recorded_at)`) needs **no
extension**, so it's always available on Supabase.

| Dimension | Plain table (today) | Native partitioning | TimescaleDB (if available) |
|---|---|---|---|
| **Read perf** | Excellent to ~10s of millions of rows with the right index | Partition pruning helps time-range scans at 100M+ | Best at huge scale (chunk exclusion), *if* TSL features present |
| **Write perf** | Excellent (plain INSERT) | Equivalent; routing overhead negligible | Equivalent |
| **Storage** | Baseline | Baseline (drop old partitions cheaply) | Best *only with compression* — absent in Supabase's build |
| **Maintenance** | ~zero | Moderate — must create future partitions (pg_cron / pg_partman) | Higher — chunk / retention / policy management |
| **asyncpg / raw SQL compat** | Native | Native — transparent to app queries | Needs raw-SQL hypertable setup outside any ORM |
| **RLS** | Working today | Policies inherit to partitions cleanly | Needs per-chunk verification |
| **Scalability** | Good | Very good | Excellent at extreme scale |
| **Vendor lock-in** | None | None (standard Postgres) | **High** (Timescale-specific DDL & dump format) |
| **Operational overhead** | Lowest | Low–moderate | Highest |

**Native partitioning pros:** no extension, no lock-in, portable, transparent to
the existing unfiltered RLS queries, partition-drop makes retention trivial.
**Cons:** you own partition creation/automation; premature below ~tens of millions
of rows; PK must include the partition key (`(kpi_id, recorded_at)` already does —
a lucky fit).

---

## 4. Recommendation

**Option A (TimescaleDB): Not recommended.** Availability on Supabase is
unverified/deprecated, the available build lacks the features that justify it, and
it adds real vendor lock-in and DR risk for a workload that doesn't need it.

**Option B (Native Partitioning): Recommended — but as a deferred, scale-triggered
step, not now.**

The honest headline: **neither is needed today.** Back-of-envelope worst case —
1,000 tenants × 50 KPIs × 52 weeks × 10 years ≈ **26M rows**, and realistically far
less. That is trivial for the current plain `(kpi_id, recorded_at)` btree-indexed
table. Partitioning becomes worth its maintenance cost only when the table reaches
tens of millions of rows *and* time-range query latency measurably degrades.

**Recommended architecture:**
- **Keep the existing plain append-only `kpi_scores` table as the production
  design.** It already meets every immutability/query requirement.
- **Adopt native range partitioning by `recorded_at` as the pre-planned scale
  lever** — documented and benchmarked now, implemented only when a defined trigger
  fires (see success criteria).
- **Drop TimescaleDB from the roadmap** unless the §2 spike surprises us *and* a
  future need for compression / continuous-aggregate rollups appears.

---

## 5. Detailed Action Plan (analysis / spike only — no implementation)

**Track 1 — Extension verification spike (§2).** Read-only queries against real
Supabase → yes/no doc.

**Track 2 — Partitioning design study (no DDL executed):**
- Document target partition scheme (`RANGE (recorded_at)`, yearly or monthly),
  confirming PK `(kpi_id, recorded_at)` already satisfies the "PK must contain
  partition key" rule.
- Specify automation approach (`pg_cron` — verify it's enabled on Supabase — or
  `pg_partman`) for rolling future partitions.
- Confirm the existing RLS policy text (`01_schema.sql:194`) applies unchanged to a
  partitioned parent.
- Define the one-time migration path (create partitioned table → copy → swap) and
  its downtime/lock profile — as a written plan only.

**Track 3 — Scale benchmark (throwaway DB, no prod change):** load synthetic data
at 1M / 10M / 50M rows into (a) plain and (b) partitioned copies; measure
latest-value and trend-range query latency and INSERT throughput. This produces the
*actual trigger threshold* for Option B.

**Track 4 — Backend/frontend impact register (analysis only, see §7/§8).**

---

## 6. Estimated Effort for the POC

| Track | Effort |
|---|---|
| T1 — Extension verification spike | **0.5 day** |
| T2 — Partitioning design study | **1–1.5 days** |
| T3 — Scale benchmark harness + runs | **1.5–2 days** |
| T4 — Impact register write-up | **0.5 day** |
| **Total** | **~3.5–4.5 days**, one engineer |

Note the immutable-history feature itself is **0 days** — it's already built and
validated (`README.md` lists the 3-consecutive-RED auto-issue test as passing).

---

## 7. Backend changes eventually required (analysis only — do NOT implement)

Because the storage design already exists, changes are minimal and mostly
*conditional on adopting partitioning*:

- **Migrations:** one new numbered SQL file (e.g. `20_kpi_scores_partitioning.sql`)
  — *only if* Track 3 justifies it. No ORM migration (no Prisma).
- **Repository/query layer:** **no change** — partitioning is transparent to the
  existing `SELECT … FROM kpi_scores` queries in `scorecards.py`.
- **Services:** optional `time_bucket()`-style monthly/quarterly rollups are flagged
  as a Phase-2 want in `ARCHITECTURE-GAPS.md:184`; these are plain SQL
  `date_trunc()` aggregations, no extension needed.
- **Validation:** consider a DB-level guard (trigger/revoke) to *enforce*
  append-only, since immutability is currently a convention in app code, not
  enforced by the schema. Worth flagging.
- **APIs:** no new endpoints required for the core POC.

---

## 8. Frontend impact eventually needed (analysis only)

There's an existing `frontend/app/dashboard/scorecards` view already consuming
`weekly_history`. Storage changes are **invisible** to it (API shape unchanged).
Genuinely new UI would only be *feature* work, not storage-driven:
- KPI history trend chart (data already served chronologically).
- Latest-value display (already served via `current_rag`).
- Longer-range / timeline + monthly/quarterly comparison — depends on the rollup
  service above.

---

## 9. Risks

- **Migration risk (partitioning):** converting a populated table to partitioned
  requires a copy-and-swap with a table lock; must be scheduled. Mitigated by doing
  it before volume grows.
- **Vendor lock-in:** high for TimescaleDB, zero for native partitioning — a
  decisive factor.
- **Performance:** partitioning *before* it's needed can slightly *hurt* small-scan
  latency (planning overhead). Don't adopt prematurely.
- **RLS:** any storage change must re-prove tenant isolation; the existing test
  suite already covers this pattern and should be re-run.
- **Append-only not schema-enforced:** immutability relies on app discipline today —
  a real risk worth a DB-level constraint.
- **Prisma:** not applicable; the risk is instead that upstream planning docs
  *assume* Prisma and mislead effort estimates.

---

## 10. Open Questions & Assumptions

1. **Why does the brief assume Prisma?** The repo is FastAPI / asyncpg / raw SQL.
   Is Prisma planned elsewhere, or is the brief inherited from a template?
   *(Blocks the Prisma-specific sections.)*
2. **Was it noticed that the immutable-history POC is already built?** If yes, is
   the real ask specifically the TimescaleDB-vs-partitioning scale decision? This
   doc assumes so.
3. **What is the realistic data-volume ceiling** (tenant count, KPIs per tenant,
   entry frequency, retention years)? This determines whether Option B is ever
   triggered.
4. **Is `pg_cron` enabled** on the target Supabase project? Needed for partition
   automation.
5. **Are monthly/quarterly rollups in scope** for this POC, or a later phase?
   `ARCHITECTURE-GAPS.md:184` lists them as future.

---

## Success Criteria for the POC

- **Extension question answered definitively** — a yes/no on TimescaleDB
  availability on the real Supabase project, backed by `pg_available_extensions`
  output.
- **A defined, data-backed trigger threshold** for adopting native partitioning
  (row count + query-latency figures from Track 3), so the decision is quantitative,
  not a guess.
- **A written, lock-profiled migration path** to partitioning that requires **no
  application query changes** and preserves RLS tenant isolation.
- **Confirmation that immutability + latest + trend retrieval** continue to hold
  under the chosen storage design (they already pass today).

---

## 11. Alternative Supabase-native architectures (TimescaleDB substitute)

Since TimescaleDB is confirmed unavailable (§2), the path is to reassemble its
value from Supabase-supported parts. TimescaleDB is really a bundle of five
features, each with a native equivalent:

| TimescaleDB feature | Supabase-native replacement | Verified available |
|---|---|---|
| Hypertables (auto time-chunking) | Native `PARTITION BY RANGE (recorded_at)` | ✅ core Postgres |
| Auto chunk creation + retention policy | `pg_partman` 5.3.1 driven by `pg_cron` 1.6.4 | ✅ |
| `time_bucket()` rollups | `date_bin()` / `date_trunc()` | ✅ core (PG14+) |
| Continuous aggregates (incremental rollups) | Trigger-maintained rollup table *or* matview + `pg_cron` refresh | ✅ |
| Columnar compression | No true equivalent → BRIN index on `recorded_at` + partition archival/drop | ✅ (partial) |

Three concrete plans are built from this. Pros/cons below; **no implementation.**

### Plan A — Partitioning + `pg_partman` + `pg_cron` + BRIN *(recommended)*

The closest thing to TimescaleDB without the extension or the lock-in.

**Pros**
- Closest thing to TimescaleDB — auto-partition creation, retention, and
  time-range pruning all covered.
- **Zero application query changes** — PK `(kpi_id, recorded_at)` already fits the
  partition-key rule; existing `scorecards.py` queries are transparent to it.
- No vendor lock-in — standard Postgres; portable off Supabase anytime.
- Cheap retention — drop an old partition instantly vs. row-by-row DELETE.
- BRIN index on `recorded_at` is tiny (KBs) and ideal for append-only, time-ordered
  data — the one native storage win that echoes Timescale.
- Both `pg_partman` and `pg_cron` are confirmed present on this project (§2).

**Cons**
- No columnar compression — the biggest Timescale feature has no native equivalent;
  storage stays at Postgres baseline.
- New operational surface — `pg_partman` + `pg_cron` can silently fail (a missed
  maintenance run = missing future partition = failed INSERTs). Needs monitoring.
- Premature below tens of millions of rows — planning overhead can slightly *slow*
  small scans at current volume.
- Migration cost — converting the populated table needs a copy-and-swap with a
  table lock (one-time, scheduled; `pg_repack` can reduce the lock window).
- RLS must be re-verified — policies need to propagate to `pg_partman`-created
  child partitions.

### Plan B — Plan A + trigger-maintained rollup table (continuous-aggregate substitute)

A small `kpi_rollups` summary table kept current by an `AFTER INSERT` trigger on
`kpi_scores`, giving live monthly/quarterly/annual rollups.

**Pros**
- Replicates continuous aggregates — near-real-time rollups.
- O(1) dashboard reads — reads a small summary table instead of scanning raw history.
- Directly satisfies the `ARCHITECTURE-GAPS.md:184` monthly/quarterly rollup want.
- Rollups stay live on every insert — no staleness window.
- Inherits all of Plan A's pros.

**Cons**
- Most moving parts — a trigger on every insert adds write-path latency and a
  correctness burden.
- Immutability risk — rollup logic must append/upsert the summary only and never
  touch raw scores; a bug here undermines the append-only guarantee.
- Backfill complexity — historical rollups must be computed once and kept consistent
  with late-arriving data.
- Trigger-maintained derived state is a classic source of subtle drift bugs.
- Inherits all of Plan A's cons.

### Plan C — Plan A + scheduled materialized views (`pg_cron` refresh)

`REFRESH MATERIALIZED VIEW CONCURRENTLY` on a `pg_cron` schedule instead of triggers.

**Pros**
- Simplest rollup approach — declarative matview + a cron refresh; almost no custom
  code.
- No write-path impact — nothing runs on insert, so ingest stays fast and simple.
- Low bug surface — recompute-from-source each refresh, so no incremental-drift class
  of bugs.
- Full recompute is cheap at this data volume.
- Inherits all of Plan A's pros.

**Cons**
- Staleness window — rollups lag by the refresh interval (e.g. up to an hour); not
  live.
- Full recompute each refresh — fine now, scales worse than Plan B's incremental
  approach as volume grows.
- `REFRESH … CONCURRENTLY` needs a unique index on the matview and still holds
  resources during refresh.
- Another `pg_cron` job to monitor.
- Inherits all of Plan A's cons.

### Recommendation among the three

**Plan A as the design (implement only when the §5 benchmark trigger fires); add
Plan B only if live rollups become a hard requirement, otherwise Plan C.** Plan A
is "TimescaleDB rebuilt from Supabase-supported parts" — ~80% of the value
(auto-partitioning, retention, pruning, BRIN) with zero lock-in and no unavailable
extension. One-line trade: A = the scale-partitioning foundation (least
complexity); B = live rollups at the cost of most complexity/risk; C = simple
rollups at the cost of freshness.

---

## Bottom Line

The immutable Scorecard KPI history already works on a plain append-only table.
TimescaleDB is now **verified unavailable** on this Supabase project (§2), so
Option A is dead. Recommend keeping the current plain table and treating **native
partitioning + `pg_partman` + `pg_cron` (Plan A, §11) as a documented,
benchmark-triggered scale lever** rather than building it now — all of its
dependencies are confirmed present. ~3.5–4.5 days of analysis/spike work, zero
production schema changes.
