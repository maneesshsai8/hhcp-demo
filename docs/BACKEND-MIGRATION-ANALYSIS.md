# Backend Migration Analysis & Action Plan
## Python (FastAPI) → JavaScript / TypeScript

> **Status: analysis and planning only.** No implementation code, no NestJS
> project, no Docker files, no migrations, and no changes to the Python backend,
> the frontend, or the PostgreSQL schema are included or intended here.
> Implementation will be requested separately after this plan is reviewed.
>
> Grounded in a full read of the codebase as of commit `922943d`
> (`backend/`, `database/`, `frontend/`). Every claim below is traceable to a file.

---

## 1. Executive Summary

The HHCP backend is a **FastAPI (Python 3) application** — ~5,900 lines of app
code across **17 routers exposing 116 endpoints** (114 HTTP + 1 WebSocket +
`/health`), backed by **`asyncpg` with hand-written, parameterized SQL and no
ORM**. The database is doing an unusually large share of the work: **tenant
isolation via Row-Level Security (RLS)**, **authorization via `SECURITY DEFINER`
functions**, **scheduling via `pg_cron`**, **time-series lifecycle via declarative
partitioning + `pg_partman` + BRIN**, and **search via a generated `tsvector` +
GIN/`pg_trgm`**.

**The single most important finding: this migration is an application-tier port,
not a database port.** Because PostgreSQL stays and the security model lives
*inside* PostgreSQL, roughly 35 SQL files and every RLS policy, DB function,
partition, and cron job **carry over unchanged**. The work is re-implementing the
Python request/handler/worker tier in TypeScript while faithfully preserving one
load-bearing idiom: *acquire a connection, open a transaction, set
`app.current_user_id` with `SET LOCAL`, run all queries on that connection.* Get
that right and RLS keeps protecting every query for free; get it wrong and the
entire authorization model silently fails open or returns empty.

**Feasibility: HIGH, with two genuine risk clusters** — (1) faithfully porting
the RLS connection-scoping idiom under a Node driver/ORM that wants to manage
pooling itself, and (2) the Playwright/Chromium PDF dependency and the in-process
WebSocket/rate-limiter state, both of which are already flagged in
`ARCHITECTURE-GAPS.md` as not production-shaped.

**Recommended framework: NestJS (Option A, the stated preference) on the Fastify
HTTP adapter**, with a **raw-SQL data layer (`postgres.js` or `slonik`) — not
Prisma** — and **Drizzle Kit / `node-pg-migrate` for raw-SQL migrations** so the
existing numbered `.sql` files are adopted wholesale rather than reverse-modeled
into an ORM schema. NestJS earns its keep here specifically because the codebase
already has enterprise concerns (dependency-injected auth guards, a transactional
outbox, background workers, event-driven fan-out, microservice-ready seams) that
NestJS models natively and Express/Fastify/Hono leave you to hand-build.

**Recommended strategy: strangler-fig, API-by-API, behind a reverse proxy**, with
a `BE_SERVER=python|node` switch that routes path-prefixes to whichever backend
owns them. Both backends talk to the **same** PostgreSQL and the **same** RLS, so
they are interchangeable at the API boundary and can run side by side for the
entire migration. Because the frontend already targets a **single `API_BASE`
constant** ([frontend/lib/api.js:3](../frontend/lib/api.js#L3)), **zero frontend
changes** is achievable.

**Rough effort: 12–18 engineer-weeks** for 100% parity (see §14), dominated by the
meetings module (28 endpoints, a dual state machine, optimistic locking,
idempotency, outbox emission) and the ~199 raw SQL statements.

---

## 2. Existing Backend Analysis (Complete Inventory)

### 2.1 Stack & folder structure

```
backend/
  app/
    main.py              # FastAPI app, CORS, 3 middlewares, 17 routers, WS route, /health
    config.py            # hand-rolled .env loader (os.environ.setdefault), ~21 env vars
    database.py          # asyncpg pool + get_scoped_connection() — the RLS idiom
    dependencies.py      # get_current_user (dual-provider), token extraction
    security.py          # bcrypt, HS256 JWT issue/verify, refresh-token hashing
    supabase_auth.py     # Supabase JWT verify (ES256/JWKS or HS256 local), refresh
    permissions.py       # role→action matrix, require_permission / _row / _leadership
    middleware.py        # SecurityHeaders + in-memory fixed-window RateLimit
    idempotency.py       # Idempotency-Key store (meeting_idempotency, 48h TTL)
    sanitizer.py         # stdlib HTML allowlist sanitizer (no native deps)
    outbox.py            # transactional outbox writer (emit)
    schemas.py           # Pydantic response models (OpenAPI contracts)
    audit.py             # audit_log writer
    mailer.py            # smtplib SMTP sender (→ Mailpit in demo)
    calendar.py          # Google/MS calendar Protocol + scaffolded adapters
    lucid.py             # Lucidchart OAuth token-embed minting (httpx)
    realtime.py          # in-process WebSocket room manager (/ws/meetings/{id})
    realtime_broadcast.py# Supabase Realtime Broadcast publisher (httpx)
    meeting_summary.py   # post-meeting summary builder
    agendas.py           # static L10 agenda templates
    reports.py           # openpyxl (xlsx) + Playwright/fpdf2 (pdf/png) generation
    routers/             # 17 routers (see §2.2)
    workers/
      runner.py          # entrypoint: python -m app.workers.runner (SEPARATE process)
      outbox_worker.py   # SKIP-LOCKED poller, exp backoff, event dispatch
  scripts/lucid_oauth.py # one-off OAuth helper to obtain the Lucid refresh token
  requirements.txt       # 11 pinned deps (see §2.9)
database/                # 35 numbered .sql files + 3 Python seed/migrate scripts
frontend/                # Next.js 14 App Router (JS, not TS) — unchanged in scope
```

### 2.2 API surface — 116 endpoints across 17 routers

Almost every route depends on `Depends(get_current_user)`; data isolation is
enforced by **RLS**, layered with app-tier `require_permission` /
`require_row_permission` / `require_leadership` / inline `is_fund_admin` checks.

| Router | Prefix | # | Notable |
|---|---|--:|---|
| auth | `/auth` | 7 | Dual-provider login/refresh/logout, `switch-tenant`, `/me`, Supabase session bootstrap. The only unauthenticated routes. |
| organizations | `/organizations` | 6 | PortCo provisioning, Tier-2 grants (grant/revoke). Fund-admin gated. |
| users | `/users` | 4 | Directory, create login (bcrypt), CSV bulk import (in-body, not multipart). `users` has **no RLS** — app-gated. |
| teams | `/teams` | 5 | Team + membership CRUD; insert gated by RLS `WITH CHECK`. |
| scorecards | `/scorecards` | 7 | KPIs + weekly RAG history; **append-only scores**; **3-RED-streak auto-creates an Issue** synchronously. |
| rocks | `/rocks` | 4 | Multi-assignee; ladders up to VCB workstreams. |
| issues | `/issues` | 6 | Drag-ranked; `/issues/stats` 8-week velocity report. |
| meetings | `/meetings` | 28 | **Largest / most complex** (757 LOC): meeting + per-segment state machines, optimistic version locking, **Idempotency-Key**, **outbox emission**, calendar sync, ratings. |
| seats | `/seats` | 12 | Accountability chart tree, reparent w/ loop-detection, version snapshots, **Lucid embed session minting**. |
| todos | `/todos` | 6 | Composable filters, `/stats`, weekly `carry-forward`. |
| directory | `/directory` | 1 | Assignable users via `SECURITY DEFINER` `assignable_users()`. |
| reports | `/reports` | 6 | **Binary downloads**: xlsx/pdf/png; `X-Report-Engine` header (playwright\|fpdf2). |
| audit | `/audit` | 1 | Compliance trail; fund-admin/viewer only; `audit_log` is **RLS-free**. |
| vcbs | `/vcbs` | 7 | Value Creation Blueprints + workstreams; `require_leadership`. |
| federation | `/federation` | 1 | Query-time cross-tenant rollup; returns `fanout_ms`/`tenants_scanned` (perf POC). |
| vision | `/vision` | 2 | V/TO doc per tenant; `require_leadership`. |
| announcements | `/announcements` | 11 | Full-text feed, HTML sanitization, **outbox fan-out**, scheduled publish (pg_cron), reactions/comments/acks, delivery reports. |
| _(non-router)_ | — | 2 | `GET /health`; `WS /ws/meetings/{id}`. |

**Non-standard patterns to preserve exactly:** binary file downloads with
`Content-Disposition`; the `X-Report-Engine` response header; `Idempotency-Key`
request header on meeting start/complete; `expected_version` optimistic-lock →
`409`; transactional outbox → async fan-out; ephemeral realtime nudges; scheduled
publishing via a per-minute `pg_cron` job; CSV parsed from a JSON body field (no
`multipart/form-data` anywhere); no SSE, no long-polling.

### 2.3 Authentication (see §11 for full strategy)

- **Two providers** switched by `AUTH_PROVIDER` (`local` default | `supabase`),
  resolved centrally in [dependencies.py:27](../backend/app/dependencies.py#L27).
- **Local:** HS256 JWT (`PyJWT`), 15-min access / 14-day refresh; passwords via
  `bcrypt`; refresh tokens stored as **SHA-256 hashes** in `refresh_tokens`,
  revoked server-side. Minimal claims (`user_id`, `active_tenant_id`) — **no
  accessible-tenant list is baked in** (Option B).
- **Supabase:** verifies **ES256 via JWKS** (hosted) or **HS256 shared secret**
  (local CLI); maps token `sub` → `users.supabase_uid`; **invite-only** linking.
- **httpOnly cookies are primary** (`access_token`, `refresh_token`,
  `sb_refresh_token`), Bearer header as fallback. Transparent refresh-on-401 is
  handled by the frontend wrapper.

### 2.4 Authorization / RBAC / multi-tenancy (see §11)

- **RLS is the security model.** ~25+ tables `ENABLE ROW LEVEL SECURITY` with a
  `tenant_isolation_*` policy calling
  `user_accessible_tenants(current_setting('app.current_user_id')::uuid)`. The
  `hhcp_app` role is deliberately non-owner/non-superuser so RLS always applies.
- **`user_accessible_tenants()`** (recursive CTE) and **`user_role_for_tenant()`**
  (walks up the tenant tree to the nearest grant) are `SECURITY DEFINER` SQL
  functions — the guts of every policy.
- **App-tier action matrix** ([permissions.py](../backend/app/permissions.py)):
  11 roles → `{view, create, edit, delete, provision}`, enforced **in-handler**
  (not as a dependency) on the scoped connection.
- **Within-tenant scoping** (`09_within_tenant_scoping.sql`): `manager`/
  `team_member` see own/reports' records via `user_can_see_record()`.
- **Active tenant** rides in the JWT (local) or a cookie/header (supabase);
  `switch-tenant` re-validates against the live grant list before re-minting.

### 2.5 Background processing (see §12)

- **Transactional outbox** ([outbox.py](../backend/app/outbox.py)): `emit()`
  writes an event row on the *same* transaction as the domain change.
- **Separate worker process** ([workers/runner.py](../backend/app/workers/runner.py)):
  a `FOR UPDATE SKIP LOCKED` poller over `meeting_outbox`, exponential backoff
  (2ⁿ capped 5 min, 8 attempts), stuck-row reaper. **Homegrown — no Celery/RQ/
  BullMQ.**
- **9 event types:** `calendar.create`, `meeting.started|paused|resumed|
  cancelled|completed`, `segment.changed`, `segment.updated`, `agenda.reordered`,
  plus `announcement.published|updated` fan-out (recipients snapshot →
  `notification_deliveries` → email → realtime).
- **`pg_cron` (3 jobs):** `kpi_scores` partman maintenance (daily), `notification_
  deliveries` partman maintenance (daily), **`publish_due_announcements()` every
  minute** (scheduled-publish → outbox).

### 2.6 Integrations

- **Email:** `smtplib` → local Mailpit in demo ([mailer.py](../backend/app/mailer.py)),
  best-effort, plain-text.
- **Realtime:** (a) in-process WebSocket rooms ([realtime.py](../backend/app/realtime.py))
  — presence/section/refetch; (b) Supabase Realtime Broadcast via `httpx` from the
  worker ([realtime_broadcast.py](../backend/app/realtime_broadcast.py)).
- **Lucidchart:** OAuth refresh → short-lived embed session token via `httpx`
  ([lucid.py](../backend/app/lucid.py)).
- **Calendar:** Google/Microsoft `Protocol` + **scaffolded** adapters (raise
  `CalendarNotConfigured` until creds exist) ([calendar.py](../backend/app/calendar.py)).
- **Reports:** `openpyxl` (xlsx), **Playwright headless Chromium** HTML→PDF/PNG
  with a pure-Python **`fpdf2` fallback** ([reports.py](../backend/app/reports.py)).

### 2.7 Cross-cutting

- **Middleware** ([middleware.py](../backend/app/middleware.py)): security headers
  (nosniff, X-Frame DENY, Referrer-Policy); **in-memory fixed-window rate limiter**
  (200/60s per IP — per-process, not shared); CORS (`localhost` regex, credentials).
- **Idempotency** ([idempotency.py](../backend/app/idempotency.py)): body-hash keyed,
  replay stored response, `409` on key reuse with different body.
- **Sanitization** ([sanitizer.py](../backend/app/sanitizer.py)): stdlib allowlist
  HTML sanitizer; blocks `javascript:`/`data:`; forces `rel="noopener…"`.
- **Audit** ([audit.py](../backend/app/audit.py)): writes to RLS-free `audit_log`.
- **Validation:** Pydantic request models + `schemas.py` response models feeding
  OpenAPI (`/openapi.json` → `frontend/lib/api-types.d.ts`).
- **Logging:** stdlib `logging` (worker); the API relies on Uvicorn logs.
- **Config:** `os.environ.setdefault` .env loader; **insecure demo defaults** for
  `JWT_SECRET`/`DATABASE_URL`.

### 2.8 Database layer

- **199 raw SQL statements** (`conn.fetch/fetchrow/fetchval/execute`) across 18
  modules — heaviest in `meetings.py` (47), `announcements.py` (26), `seats.py`
  (21). Positional `$1` params, explicit `::uuid`/`::jsonb` casts, JOINs/CTEs/
  window functions/FTS operators embedded as strings.
- **No ORM anywhere** (zero SQLAlchemy/Tortoise/Prisma imports).
- **`get_scoped_connection(user_id)`** ([database.py:38](../backend/app/database.py#L38))
  is the architectural centerpiece: acquire → `BEGIN` → `set_config('app.current_
  user_id', $1, true)` (`SET LOCAL`) → run queries → commit. **One request = one
  transaction = one RLS scope.** Routers never call `conn.transaction()`
  themselves and never write `WHERE tenant_id = …`.
- **Advanced Postgres in use:** RLS everywhere; `SECURITY DEFINER` functions with
  recursive CTEs; **declarative range partitioning + `pg_partman` + `pg_cron`**
  (`kpi_scores`, `notification_deliveries`); **BRIN** indexes; **generated
  `tsvector` STORED + GIN + `pg_trgm`**; partial indexes; JSONB; DEFERRABLE unique
  constraint; transactional outbox. **No triggers, no materialized views.**
- **Migrations:** hand-numbered `.sql` applied via `psql` — **no framework**.
  ⚠️ Two `19_*` and two `20_*` files (ordering ambiguity a real tool would reject).
  Python scripts `seed.py`, `seed_hierarchy.py`, `migrate_users_to_supabase.py`
  are data/bootstrap (psycopg2), not schema DDL.

### 2.9 Dependencies & environment variables

**Python deps** (`requirements.txt`): `fastapi`, `uvicorn`, `asyncpg`, `pyjwt`,
`bcrypt`, `pydantic`, `python-multipart`, `openpyxl`, `fpdf2`, `playwright`,
`cryptography`, `certifi`.

**~21 env vars:** `DATABASE_URL`, `AUTH_PROVIDER`, `JWT_SECRET`; `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS_URL`,
`SUPABASE_JWT_SECRET`; `SMTP_HOST/PORT/FROM`; `LUCID_CLIENT_ID/SECRET/
REFRESH_TOKEN/API_VERSION/EMBED_ORIGIN`; `GOOGLE_CALENDAR_*` and `MS_CALENDAR_*`
(client id/secret/refresh token).

---

## 3. Framework Comparison

Scored for **this** codebase's actual needs (raw-SQL + RLS, DI-style guards,
transactional outbox, background workers, WebSockets, event fan-out,
microservice-ready seams), not in the abstract.

| Criterion | **NestJS** | **Fastify** | **Express** | **Hono** |
|---|---|---|---|---|
| Performance | High (Fastify adapter) | Highest | Moderate | Very high (edge) |
| Scalability | High | High | Moderate | High |
| TypeScript support | Native, first-class | Excellent | Via `@types` | Native, first-class |
| Learning curve | Steep (DI/decorators) | Gentle | Gentlest | Gentle |
| Enterprise readiness | Excellent (opinionated) | Good (DIY) | DIY | Emerging |
| Dependency Injection | **Built-in** (matches FastAPI `Depends`) | None (manual) | None | None |
| Auth support | Guards/strategies (Passport) | Plugins | Middleware | Middleware |
| Authz support | Guards + custom decorators | DIY | DIY | DIY |
| PostgreSQL support | Any driver | Any driver | Any driver | Any driver |
| **Prisma compatibility** | First-class — **but see §10; we recommend NOT using Prisma** | Good | Good | Good |
| Testing ecosystem | Excellent (`@nestjs/testing`) | Good (`tap`) | Mature (`supertest`) | Growing |
| Long-term maintainability | High (structure enforced) | Med-high | Low at scale | Med |
| Community | Very large | Large | Largest | Growing |
| Microservice readiness | **Built-in transports** (TCP/NATS/Kafka/Redis) | DIY | DIY | DIY |
| Event-driven support | `@nestjs/event-emitter`, CQRS, microservice events | DIY | DIY | DIY |

**Option E (other) considered:** **AdonisJS** (batteries-included, Rails-like) and
**tRPC** (end-to-end types). Both rejected: AdonisJS's Lucid ORM fights the
raw-SQL/RLS pattern, and tRPC breaks the **zero-frontend-change** constraint (it
abandons REST/OpenAPI, which the existing `api-types.d.ts` contract depends on).

**Verdict:**
- **Express** — most familiar, but you rebuild DI, guards, config, module
  boundaries, and microservice transports by hand. False economy for a codebase
  this structured.
- **Hono** — superb for edge/serverless, but its sweet spot (stateless, ephemeral
  handlers) is the opposite of what this app needs: **long-lived pooled
  connections carrying `SET LOCAL` transaction scope** and a **persistent
  WebSocket room manager**. Wrong fit for the RLS idiom.
- **Fastify** — the pragmatic minimalist choice; excellent perf and TS. Viable if
  the team wants less magic. You hand-build the DI/guard/module structure that
  NestJS gives you and that the Python app already relies on.
- **NestJS (recommended)** — the structural analogue of the current FastAPI app:
  DI ≈ `Depends`, Guards ≈ auth/permission dependencies, Modules ≈ routers,
  interceptors ≈ middleware, built-in microservice/event transports ≈ the Phase-2
  Kafka/outbox direction already documented in `ARCHITECTURE-GAPS.md §4`. It also
  runs **on the Fastify adapter**, so you get Fastify's throughput without giving
  up structure.

---

## 4. Recommended Framework

**NestJS 10+ on the `@nestjs/platform-fastify` adapter, TypeScript strict mode.**

Technical justification, specific to this repo:

1. **DI maps 1:1 from FastAPI.** The Python app leans on `Depends(get_current_
   user)` and in-handler `require_permission`. In NestJS these become an
   `AuthGuard` + a `@RequirePermission()` decorator/guard — same mental model,
   enforced consistently, testable in isolation.
2. **Module boundaries mirror the 17 routers**, giving a clean per-feature
   migration unit for the strangler-fig plan (§13).
3. **Native event/microservice transports** are the exact Phase-2 target already
   named in the codebase (transactional outbox → Kafka consumers). Starting on
   NestJS means that evolution is configuration, not a second rewrite.
4. **Fastify adapter** closes most of the raw-throughput gap vs. Express/Fastify
   while keeping structure (see §12 performance).
5. **It does not force an ORM.** NestJS is data-layer agnostic; we pair it with a
   **raw-SQL layer** (§10) so the 199 existing queries and the RLS idiom port
   directly.

**Data layer (critical, see §10):** `postgres.js` (or `slonik`) as the driver,
wrapped in a request-scoped provider that reproduces `get_scoped_connection` using
**`AsyncLocalStorage`** to carry the one transaction-scoped client through the
request. **Drizzle** optional as a typed query builder for *new* simple queries;
**Prisma is not recommended** because it fights per-request `SET LOCAL` scoping.

**Migrations:** adopt the existing numbered `.sql` files verbatim via
`node-pg-migrate` or Drizzle Kit's raw-SQL migrations. Fix the `19_/20_` numbering
collision on adoption.

---

## 5. Migration Feasibility

**Overall: feasible, high confidence.** The schema, RLS, DB functions, partitions,
and cron jobs are **language-agnostic and stay in place**, which removes the
riskiest class of work (data-model migration) entirely. What remains is a
well-bounded application-tier reimplementation.

**Library replacement map:**

| Python | Node/TS replacement | Risk |
|---|---|---|
| FastAPI | NestJS (+ Fastify adapter) | Low |
| Pydantic | `class-validator` + `class-transformer` (Nest DTOs) / `zod` | Low |
| asyncpg | `postgres.js` or `slonik` (`pg` also fine) | **Med** (RLS scoping idiom) |
| PyJWT (HS256) | `jsonwebtoken` | Low |
| PyJWT (ES256 + JWKS) | `jose` (`jwtVerify` + `createRemoteJWKSet`) | Med |
| bcrypt | `bcrypt`/`bcryptjs` (`$2b$` hashes are portable) | Low |
| stdlib sanitizer | `sanitize-html` / DOMPurify (same allowlist) | Low |
| openpyxl | `exceljs` | Low |
| fpdf2 | `pdfkit` (fallback engine) | Low |
| Playwright (Python) | `playwright` (Node — first-class) | **Med** (Chromium binary/infra) |
| smtplib | `nodemailer` | Low |
| httpx | `undici`/global `fetch` | Low |
| in-process WS rooms | `@nestjs/websockets` + `ws`; Redis adapter for scale-out | Med |
| in-memory rate limit | `@nestjs/throttler` (+ Redis store) | Low |
| homegrown outbox worker | standalone Nest app / `BullMQ` optional | Med |

**Runtime differences to watch:** Node is single-threaded per process — CPU-bound
report generation (Playwright, large xlsx) must stay off the event loop (worker
threads or a separate report service). asyncpg's rich native type coercion (UUID,
`jsonb`, interval-string building like `($8 || ' seconds')::interval`) must be
audited against the Node driver's coercion. A blocking `urllib.request` call in
`supabase_auth.refresh_session` is a latent bug the port should fix with async
`fetch`.

**Cost:** engineering time (§14) plus roughly-flat infrastructure — Node's lower
idle memory and faster cold start (§12) can *reduce* hosting cost; the one net-new
cost is a Redis instance (WS pub/sub + shared rate limiting) that the Python demo
also needs for production per `ARCHITECTURE-GAPS.md §4b/§6`.

---

## 6. Gap Analysis (Parity Checklist)

Every capability that must reach 100% parity. None may be dropped.

| # | Capability | Where (Python) | Parity notes |
|---|---|---|---|
| 1 | Local JWT auth (issue/verify/refresh/rotate) | security.py, auth.py | HS256, 15m/14d, SHA-256 refresh hashing |
| 2 | Supabase auth (ES256/JWKS + HS256 local) | supabase_auth.py | invite-only linking, JWKS caching |
| 3 | httpOnly cookie sessions + Bearer fallback | auth.py, dependencies.py | `samesite=lax`; add CSRF for prod |
| 4 | RLS tenant isolation | database.py + all `*.sql` | **DB-resident; preserve `SET LOCAL` idiom** |
| 5 | RBAC action matrix (11 roles) | permissions.py | in-handler enforcement |
| 6 | Within-tenant record scoping | 09_within_tenant_scoping.sql | DB-resident |
| 7 | Multi-tenant hierarchy + tenant switching | auth.py + DB functions | live re-validation (Option B) |
| 8 | Fund admin / fund viewer tiers | 18_fund_viewer.sql, inline checks | |
| 9 | All 116 endpoints (17 modules) | routers/ | exact paths, verbs, status codes |
| 10 | Meeting dual state machine + optimistic locking | meetings.py | `expected_version` → 409 |
| 11 | Idempotency-Key handling | idempotency.py | body-hash, replay, 409 |
| 12 | Transactional outbox + worker (9 events) | outbox.py, workers/ | SKIP LOCKED, backoff, reaper |
| 13 | Scorecard 3-RED auto-issue rule | scorecards.py | synchronous, transactional |
| 14 | Announcements fan-out (recipients/deliveries) | outbox_worker.py | RLS-scoped to author |
| 15 | Email delivery | mailer.py | nodemailer |
| 16 | Notifications lifecycle (partitioned) | 31/32_*.sql | DB-resident partitioning |
| 17 | Scheduled publish (per-minute cron) | 33_*.sql | **DB-resident pg_cron — keep** |
| 18 | Full-text + trigram search | 29_*.sql, announcements.py | DB-resident tsvector/GIN |
| 19 | Reports: xlsx | reports.py | exceljs |
| 20 | Reports: pdf/png + `X-Report-Engine` | reports.py | playwright + pdfkit fallback |
| 21 | Live meeting WebSocket (presence/section/refetch) | realtime.py | Redis adapter for scale-out |
| 22 | Supabase Realtime Broadcast | realtime_broadcast.py | server-side publish from worker |
| 23 | Lucid embed session minting | lucid.py | OAuth refresh flow |
| 24 | Calendar sync scaffolding | calendar.py | Google/MS adapters |
| 25 | HTML sanitization | sanitizer.py | sanitize-html, same rules |
| 26 | Rate limiting + security headers | middleware.py | throttler + Redis for prod |
| 27 | Audit logging (RLS-free) | audit.py | |
| 28 | CSV bulk user import | users.py | in-body CSV parse |
| 29 | Federation rollup + perf instrumentation | federation.py | return `fanout_ms` etc. |
| 30 | OpenAPI schema → `api-types.d.ts` | schemas.py | **must stay contract-compatible** |

---

## 7. Risks

| Risk | Sev | Description |
|---|---|---|
| **RLS scoping regression** | **High** | If the Node layer doesn't carry the one transaction-scoped connection through the whole request (`SET LOCAL app.current_user_id`), RLS returns empty or, worse, leaks across tenants on a pooled connection. This is the #1 correctness risk. |
| **Prisma impedance** | High | Prisma manages its own pool/transactions and resists per-request `SET LOCAL`; choosing it would force awkward `$executeRaw`/interactive-transaction workarounds. Mitigated by choosing a raw driver (§10). |
| **Playwright/Chromium in prod** | Med | Headless Chromium needs OS libs and memory; blocks the event loop. Mitigated by isolating report generation and the `fpdf2`→`pdfkit` fallback. |
| **In-process WS/rate-limit state** | Med | Neither survives horizontal scaling (already flagged in gaps doc). Redis adapter required for multi-instance. |
| **Behavioral drift** | Med | Subtle differences: PyJWT typed exceptions vs `jsonwebtoken` error names; bcrypt 72-byte truncation; asyncpg vs Node type coercion; float/decimal formatting in exports. Mitigated by golden-response contract tests (§16). |
| **Idempotency/optimistic-lock edge cases** | Med | Meeting concurrency semantics (409 vs 404, version bumps) must match exactly. |
| **Migration numbering collision** | Low | Duplicate `19_/20_` files break a real migration tool; resolve on adoption. |
| **Dual-run divergence** | Low-Med | Two backends on one DB during migration must not both own the same writes; the router (§13) enforces single ownership per path. |

---

## 8. Proposed Monorepo Structure

The current repo is a loose multi-folder layout (`backend/`, `database/`,
`frontend/`). Formalize it as a workspace so both backends and shared contracts
live together without disturbing the existing Python app.

```
hhcp/
  apps/
    frontend/                 # existing Next.js (moved as-is; only API_BASE env-ized)
    backend-python/           # existing FastAPI (UNCHANGED — the reference impl)
    backend-node/             # NEW — NestJS app (feature modules mirror routers)
    backend-node-worker/      # NEW — standalone Nest app: outbox worker (was workers/)
    gateway/                  # NEW — thin reverse proxy honoring BE_SERVER (§9)
  packages/
    db/                       # the numbered .sql migrations (single source of truth)
    api-contract/             # OpenAPI spec + generated api-types.d.ts (shared)
    shared-types/             # DTOs / enums shared by node backend + frontend
  package.json                # workspaces (pnpm/turbo)
```

**Why this shape:**
- `backend-python` stays a first-class, untouched app so it remains the parity
  oracle and rollback target for the whole migration.
- **`packages/db` makes the schema explicitly shared** — reinforcing that
  migrations are neither backend's private concern.
- **`packages/api-contract`** centralizes the OpenAPI/`api-types.d.ts` contract
  that both the parity tests and the frontend depend on — the mechanism that makes
  "zero frontend changes" verifiable.
- Worker split into its own app matches the Python design (a *separate process*)
  and the future microservice direction.

*(Per the brief, this is a recommendation only — not created here.)*

---

## 9. Environment Switching (`BE_SERVER=python|node`)

**Feasible and low-risk**, because both backends are interchangeable at the API
boundary (same DB, same RLS, same contracts).

**Do not** put the switch in the frontend build. Put it in a **thin reverse proxy
(`apps/gateway`)** in front of both backends:

- `BE_SERVER=python` → proxy all `/api/*` to FastAPI (`:8000`).
- `BE_SERVER=node` → proxy all `/api/*` to NestJS.
- **Per-route override (the real workhorse)** → route per path-prefix, e.g.
  `NODE_ROUTES=/auth,/todos,/vision` sends those prefixes to Node and everything
  else to Python. This is what enables the API-by-API strangler-fig (§13).

**Configuration approach:** the gateway reads `BE_SERVER` + an allowlist of
migrated prefixes; unmigrated prefixes fall through to Python. Auth cookies are
domain-scoped so they work identically regardless of which backend answers.

**Frontend:** change the single hard-coded `API_BASE`
([frontend/lib/api.js:3](../frontend/lib/api.js#L3)) to read
`process.env.NEXT_PUBLIC_API_BASE`, pointed at the gateway. That is the **only**
frontend edit, and it's config, not logic (in scope only as a recommendation).

**Local dev:** `docker compose` (recommendation only — not generated here) brings
up Postgres + both backends + gateway + frontend; `BE_SERVER` in `.env` flips the
default. **CI/CD:** run the full contract test suite (§16) against **both**
backends on every PR so parity can't silently regress. **Deployment:** blue/green
at the gateway — shift a prefix to Node, watch metrics, roll back by flipping the
prefix back to Python (no redeploy).

---

## 10. API Compatibility & Database Compatibility

### 10.1 API compatibility — zero frontend changes

- **Contracts can remain unchanged.** The Node backend must reproduce each
  endpoint's path, method, request shape, response shape, and status codes. The
  existing **OpenAPI spec + `frontend/lib/api-types.d.ts`** is the authoritative
  contract; regenerating it from the Node app and diffing against the committed
  file is a mechanical parity gate.
- **Frontend keeps working untouched.** It targets one `API_BASE`, uses httpOnly
  cookies (no token handling), and relies on standard REST/JSON — all
  reproducible. The transparent refresh-on-401 flow, `credentials: include`, and
  the `X-Active-Tenant` header (supabase mode) must all behave identically.
- **Endpoints needing special handling:** binary report downloads
  (`Content-Disposition`, `X-Report-Engine`); the WebSocket handshake (cookie-based
  auth, `4401` close code); `Idempotency-Key` semantics; optimistic-lock `409`s;
  `switch-tenant` cookie/JWT re-minting; Supabase session bootstrap cookies.
- **Backward-compat strategy:** gateway + per-prefix routing (§9) means the
  frontend never sees a cutover — a prefix flips from Python to Node behind a
  stable URL, and the contract tests guarantee response equivalence.

### 10.2 Database compatibility — PostgreSQL unchanged

- **Schema is fully compatible** — it doesn't move. The Node app connects to the
  same database with the same `hhcp_app` (non-superuser) role so RLS applies.
- **ORM recommendation:**

| | **Prisma** | **TypeORM** | **Drizzle** |
|---|---|---|---|
| RLS + per-request `SET LOCAL` | ✗ Poor (own pool/tx mgmt) | ~ Workable (`QueryRunner`) | ✓ Good (thin, exposes raw conn) |
| Raw SQL for 199 existing queries | `$queryRaw` (loses types) | `query()` | `sql` template (typed) |
| BRIN / partitioning / pg_partman / generated tsvector | ✗ Can't express | ✗ Partial | ✗ (kept as raw SQL migrations) |
| Adopt existing numbered `.sql` | ✗ Wants own migration model | ~ | ✓ Raw-SQL migrations |
| Recursive `SECURITY DEFINER` functions | ✗ | ✗ | ✗ (all → raw SQL) |

  **Recommendation: do NOT adopt a full ORM. Use a raw-SQL driver
  (`postgres.js` or `slonik`), optionally with Drizzle as a typed query builder
  for new/simple queries.** Rationale: the security model *requires* a per-request
  connection carrying `SET LOCAL app.current_user_id`, which every ORM's
  transparent pooling fights; and the advanced Postgres features (RLS,
  partitioning, cron, generated columns, DB functions) have **no ORM
  representation** and stay as raw SQL regardless. An ORM would add friction
  without removing any of the real work. Keep migrations as the existing
  numbered `.sql`, run by `node-pg-migrate`/Drizzle Kit.

  > Confirms the finding already recorded in
  > [docs/POC-timeseries-storage.md](POC-timeseries-storage.md): *"There is no
  > Prisma in this codebase."* The Prisma-oriented items in the brief have no
  > existing target and are reinterpreted here as raw-SQL/asyncpg equivalents.

---

## 11. Authentication & Authorization Strategy

**Guiding principle: keep authorization in the database (Option B). Only the
identity/session tier is rewritten.**

- **JWT (local):** `jsonwebtoken` for HS256 issue/verify; preserve claims
  (`user_id`, `active_tenant_id`, `iat`, `exp`), 15m/14d lifetimes, and the
  "expired → use /auth/refresh" message contract (distinguish
  `TokenExpiredError`). Keep refresh tokens as **SHA-256 hashes** in
  `refresh_tokens` with server-side revocation.
- **OAuth / Supabase:** `jose` with `createRemoteJWKSet` (ES256, hosted) and a
  shared-secret path (HS256, local CLI); enforce `audience="authenticated"` and
  the exact issuer; replicate JWKS caching and the **invite-only** `supabase_uid`
  linking. Supabase-owned SSO (Google/Microsoft) needs no backend logic beyond
  session bootstrap; the documented Phase-2 native OAuth
  (`ARCHITECTURE-GAPS.md §7`) is additive.
- **Sessions:** httpOnly cookies (`access_token`, `refresh_token`,
  `sb_refresh_token`), `samesite=lax`; add `secure` + CSRF token for production
  (gap noted in code).
- **RBAC:** port `permissions.py` to a NestJS `PermissionsGuard` + a
  `@RequirePermission('create')` decorator resolving the effective role via the
  DB `user_role_for_tenant()` — same source of truth, enforced as a guard instead
  of an in-handler call.
- **Multi-tenant authorization:** unchanged — it's `user_accessible_tenants()` +
  RLS in the DB. The Node app only needs to (a) set `app.current_user_id` per
  request and (b) re-validate on `switch-tenant`.
- **Middleware:** `@nestjs/throttler` (Redis store for shared limits) + a
  security-headers interceptor (consider adding CSP/HSTS, absent today).

---

## 12. Background Processing & Deployment

### 12.1 Background processing

- **Outbox worker → a standalone NestJS application** (`backend-node-worker`),
  preserving the *separate process* design. Reproduce the `FOR UPDATE SKIP
  LOCKED` claim loop, exponential backoff (8 attempts), and stuck-row reaper
  exactly. `BullMQ` (Redis) is an *optional* upgrade but **not required** — the
  DB-backed poller is sufficient and keeps parity; the handler dispatch is already
  structured so a managed queue can drop in later.
- **The 9 event types and their side effects** (summary regen, calendar sync,
  announcement fan-out, realtime publish) port as worker handlers, each running
  under the triggering actor's RLS context (`set_config`), never a superuser
  bypass.
- **Scheduled jobs stay in the database.** The three `pg_cron` jobs — including
  the per-minute `publish_due_announcements()` — are **DB-resident and unchanged**.
  Do *not* reimplement them as app-level cron; that would be a regression from a
  crash-safe design.
- **Realtime:** `@nestjs/websockets` (`ws`) for the meeting rooms; add the
  **Redis adapter** so presence/section/refetch broadcasts reach sockets on every
  instance (the documented in-process gap). Supabase Realtime Broadcast stays a
  server-side `fetch` from the worker.

### 12.2 Deployment

- **Containerize both backends + gateway + worker.** The **report/Playwright path
  is the only heavy image** — recommend a **dedicated report service** (or worker
  threads) so Chromium's memory/CPU never blocks API request handling, and API
  pods stay slim.
- **Targets:** Cloud Run / GKE / a container host for the Node API + worker;
  Vercel for the frontend; Supabase/managed Postgres for the DB (already the
  documented direction). The worker is a long-running service, not serverless
  (Cloud Run *jobs*/min-instances or a small always-on pod).
- **Improvements over the demo:** move rate limiting + WS pub/sub to **Redis**;
  put the reverse proxy/gateway in front for TLS, routing, and edge rate limiting
  (matches the Phase-2 API-gateway direction in `ARCHITECTURE-GAPS.md §6`).

### 12.3 Performance (Python/FastAPI vs Node/NestJS-Fastify)

| Dimension | FastAPI (uvicorn) | NestJS + Fastify | Practical read |
|---|---|---|---|
| Request throughput | High (async) | High–very high | Roughly comparable; Fastify edges JSON-heavy routes. **DB/RLS is the real bottleneck, not the framework.** |
| Memory (idle) | Higher (Python) | Lower (V8) | Node modestly cheaper per instance |
| Startup / cold start | Slower | Faster | Node wins — helps autoscaling |
| Async I/O | asyncio | libuv | Comparable for this I/O-bound app |
| DB performance | asyncpg (fast) | `postgres.js`/`pg` (fast) | Comparable; keep the same pooling shape |
| CPU-bound (reports) | GIL, but Playwright is out-of-proc | **single-thread — must isolate** | Node needs report work off the event loop |
| Scalability | Horizontal (needs shared state) | Horizontal (needs shared state) | Identical requirement: Redis for WS/limits |

**Bottom line:** performance is not a deciding factor — both are I/O-bound and
gated by the same PostgreSQL/RLS layer. Node's wins are lower idle memory and
faster cold start; its one caution is keeping CPU-bound report generation off the
main thread.

---

## 13. Migration Strategy & Phases

**Recommended: strangler-fig, API-by-API (Option C), module-grained**, behind the
gateway (§9). Rejected alternatives: **Big Bang** (unacceptable risk against a
116-endpoint surface with subtle concurrency semantics); **Feature-by-feature**
(cuts across modules, muddies routing ownership). API/module-by-module gives the
smallest safe increments with instant per-prefix rollback.

**Sequencing principle:** migrate low-risk, low-coupling modules first to prove the
harness (RLS idiom, auth, contract tests), then the complex core last.

| Phase | Scope | Why here |
|---|---|---|
| **0. Foundation** | Monorepo, gateway, NestJS skeleton on Fastify, raw-SQL data layer reproducing `get_scoped_connection` via `AsyncLocalStorage`, DTO validation, contract-test harness against both backends. **No endpoints yet.** | De-risks the one make-or-break idiom before any feature. |
| **1. Auth + identity** | `/auth`, `get_current_user`, guards, RBAC (`permissions.py`), middleware. | Everything depends on it; proves cookies/JWT/Supabase parity end-to-end. |
| **2. Simple CRUD** | `directory`, `vision`, `todos`, `teams`, `users`, `organizations`. | Low coupling; validates RLS + permission matrix on real modules. |
| **3. Core EOS** | `scorecards` (+ 3-RED auto-issue), `rocks`, `issues`, `seats`, `vcbs`, `federation`. | Business rules + tree logic + the synchronous automation. |
| **4. Reports** | `/reports` (exceljs + playwright/pdfkit), `X-Report-Engine`. | Isolatable; benefits from the dedicated report service. |
| **5. Async backbone** | outbox writer + standalone worker, 9 events, `announcements` fan-out, email, notifications. | Highest-value async parity; needs Phases 1–3 in place. |
| **6. Realtime + meetings** | WebSocket rooms (Redis adapter), Realtime Broadcast, then **`meetings`** (state machines, optimistic locking, idempotency, outbox). | Most complex; migrated last when the harness is proven. |
| **7. Integrations + cutover** | Lucid embeds, calendar sync, final contract-diff, flip `BE_SERVER=node` default, decommission Python per-prefix. | Long-tail + switchover. |

Each phase: implement → contract-test against Python golden responses → route the
prefix to Node in staging → monitor → promote → (rollback = flip the prefix back).

---

## 14. Estimated Effort

Order-of-magnitude, one to two senior engineers; assumes the schema/RLS/cron are
untouched (they are).

| Phase | Est. |
|---|---|
| 0. Foundation (RLS idiom, gateway, harness) | 1.5–2.5 wk |
| 1. Auth + RBAC + middleware | 1.5–2.5 wk |
| 2. Simple CRUD (6 modules) | 1.5–2 wk |
| 3. Core EOS (6 modules) | 2.5–3.5 wk |
| 4. Reports | 1–1.5 wk |
| 5. Async backbone (outbox/worker/announcements) | 2–3 wk |
| 6. Realtime + meetings (28 endpoints) | 2.5–3.5 wk |
| 7. Integrations + cutover | 1–2 wk |
| **Total** | **~12–18 engineer-weeks** |

Cost drivers: the meetings module and the 199 raw queries dominate; the DB layer
staying put is the biggest cost *saver*.

---

## 15. Risks & Mitigation

| Risk (from §7) | Mitigation |
|---|---|
| RLS scoping regression | Phase 0 proves the `AsyncLocalStorage` scoped-connection idiom with a dedicated test that asserts default-deny (no context → 0 rows) and cross-tenant isolation *before* any feature is ported. |
| Prisma impedance | Decision already made: raw-SQL driver, no ORM-managed schema (§10). |
| Playwright in prod | Dedicated report service / worker threads; keep the `pdfkit` fallback + `X-Report-Engine` observability. |
| In-process WS/rate-limit | Redis adapter for WS; `@nestjs/throttler` Redis store — required before multi-instance. |
| Behavioral drift | Golden-response contract tests run against **both** backends in CI on every PR (§16); explicit tests for bcrypt truncation, JWT expiry messages, numeric formatting, 409/404 semantics. |
| Concurrency semantics | Port meeting state-machine + idempotency with table-driven tests mirroring the documented transitions. |
| Dual-run divergence | Gateway enforces single-owner-per-prefix; no path is served by both backends simultaneously. |
| Migration numbering | Resolve `19_/20_` collisions when adopting into `node-pg-migrate`/Drizzle Kit. |

---

## 16. Success Criteria

1. **Contract parity:** OpenAPI regenerated from the Node backend diffs clean
   against the committed `api-types.d.ts`; every one of the 116 endpoints returns
   byte-equivalent (or documented-equivalent) responses for a golden request set.
2. **Zero frontend changes** beyond pointing `NEXT_PUBLIC_API_BASE` at the
   gateway — no logic edits.
3. **Security parity, proven not asserted** (mirroring the README's validation
   list): no-context → 0 rows; cross-tenant `tenant_id` in URL → empty; revoke a
   grant → effective on the very next request with the same token; `switch-tenant`
   to a non-granted tenant → 403.
4. **Behavioral parity** on the hard cases: 3-RED auto-issue fires exactly once;
   meeting optimistic-lock `409`s; idempotent meeting start/complete; outbox
   fan-out produces identical `notification_deliveries`.
5. **Background/async parity:** all 9 events processed with matching side effects;
   the three `pg_cron` jobs untouched and firing.
6. **Non-functional:** p95 latency ≤ the Python baseline per endpoint; report
   generation off the request thread; WS presence correct across ≥2 instances
   (Redis adapter).
7. **Operational:** both backends pass the same CI contract suite; per-prefix
   rollback demonstrated in staging.

---

## 17. Rollback Strategy

Rollback is **built into the architecture, not bolted on**:

- **Per-prefix, instant:** the gateway routes each path-prefix to Python or Node.
  Reverting a migrated module is flipping its prefix back to Python — **config
  change, no redeploy, seconds to take effect.**
- **No data rollback needed:** both backends share one PostgreSQL with one schema
  and one RLS model. There is no divergent data store to reconcile, so a rollback
  never risks data.
- **Single ownership invariant:** because only one backend serves a given prefix
  at a time, reverting cannot create split-brain writes.
- **Full stop:** setting `BE_SERVER=python` (and clearing the Node prefix
  allowlist) returns 100% of traffic to the untouched FastAPI app — which remains
  a first-class, maintained application throughout the migration (§8).
- **Session continuity:** cookies are domain-scoped and both backends validate the
  same tokens/DB sessions, so a rollback doesn't log users out.

---

## 18. Final Recommendation

**Proceed. The migration is feasible and lower-risk than a typical rewrite,
because the hardest and most valuable part of the system — the PostgreSQL schema,
RLS-based tenant isolation, `SECURITY DEFINER` authorization functions, `pg_cron`
scheduling, partitioning, and full-text search — is language-agnostic and stays
exactly where it is.** The work is a bounded application-tier port.

Concretely:
1. **Framework:** **NestJS on the Fastify adapter**, TypeScript strict — it
   mirrors the current FastAPI structure (DI, guards, modules) and natively
   supports the documented event-driven/microservice future.
2. **Data layer:** **raw SQL via `postgres.js`/`slonik`, no ORM**; adopt the
   existing numbered `.sql` migrations via a raw-SQL migration tool. **Not
   Prisma** — it fights the per-request `SET LOCAL` RLS idiom that the whole
   security model rests on.
3. **Strategy:** **strangler-fig, API-by-API, behind a `BE_SERVER`-driven
   gateway**, both backends live on the same DB, contract-tested against each
   other in CI, with instant per-prefix rollback.
4. **Non-negotiable first step:** Phase 0 must prove the RLS connection-scoping
   idiom (`AsyncLocalStorage` + one transaction-scoped client + `SET LOCAL
   app.current_user_id`) before a single feature is ported. Everything else is
   routine; this one idiom is where correctness is won or lost.
5. **Frontend:** untouched except one env-driven `API_BASE` — the single-constant
   design makes "zero frontend changes" genuinely achievable.

The demo's own `ARCHITECTURE-GAPS.md` already states the thesis this analysis
confirms: *"nothing here is FastAPI-specific at the architecture level; the schema
and RLS design port directly to Node."*

---

*Prepared as analysis and planning only. No implementation, project scaffolding,
Docker, migrations, API code, schema changes, or frontend changes were produced.*
