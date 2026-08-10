# HHCP Backend — Node (NestJS + Fastify)

The TypeScript port of the Python/FastAPI backend, built per
[docs/BACKEND-MIGRATION-ANALYSIS.md](../docs/BACKEND-MIGRATION-ANALYSIS.md).

**All 17 routers (114 REST endpoints) + the live-meeting WebSocket are ported.**
It shares the **same PostgreSQL and the same RLS** as the Python backend, so the
two are interchangeable at the API boundary and run side by side behind the
[gateway](../gateway) (`BE_SERVER` / `NODE_ROUTES`, analysis §9). The async
fan-out (outbox drain, announcement delivery, calendar sync, summary
regeneration) runs in the separate [worker](../backend-node-worker).

## What's here

| Area | File | Notes |
|---|---|---|
| RLS-scoped DB layer (**the centerpiece**) | `src/database/database.service.ts` | `scoped(userId, fn)` = `BEGIN` + `SET LOCAL app.current_user_id` + run on one connection. Faithful port of Python's `get_scoped_connection`. |
| Config | `src/config/` | Mirrors `backend/app/config.py` (env + demo defaults). |
| RBAC matrix | `src/common/permissions.ts` | Port of `permissions.py` (11 roles → actions). |
| Error shape | `src/common/http-exception.filter.ts` | Every error → `{ "detail": "..." }` (what the frontend reads). |
| Auth | `src/auth/` | 7 endpoints: `login`, `refresh`, `switch-tenant`, `logout`, `supabase-session`, `supabase-refresh`, `me`. Local HS256 JWT + Supabase (jose). httpOnly cookies. |
| Health | `src/health.controller.ts` | `GET /health`. |

## Run

```bash
cp .env.example .env          # points at the same hhcp_demo DB as the Python backend
npm install
npm run build
npm start                     # listens on PORT (default 8001)
```

The Python backend runs on `:8000`; this runs on `:8001` so both can run at once
behind the `BE_SERVER` gateway (analysis doc §9). To test the frontend against
this backend directly, set `frontend` `NEXT_PUBLIC_API_BASE` to `http://localhost:8001`
(the frontend change is out of scope for this slice — recommendation only).

## Smoke test (local provider, seeded demo data)

```bash
# health
curl -s localhost:8001/health

# login (sets httpOnly cookies into cookies.txt)
curl -s -c cookies.txt -X POST localhost:8001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@hiddenharbor.com","password":"Demo1234!"}'

# authenticated, RLS-scoped request using the cookie
curl -s -b cookies.txt localhost:8001/auth/me
```

## Parity notes / deliberate fixes

- bcrypt hashes are portable (`bcryptjs`), so existing passwords verify unchanged.
- `SET LOCAL` is transaction-scoped, so RLS context can never leak across pooled
  connections — the load-bearing invariant of Option B.
- The Python `supabase_auth.refresh_session` used a blocking `urllib` call inside
  an async app; here it's a natural async `fetch` (a fix, not a behavior change).

## Status

All phases of the analysis doc §13 are implemented: auth, the Phase-2 CRUD
modules, the Phase-3 Core-EOS modules (scorecards incl. the 3-RED auto-issue,
rocks, issues, vcbs, seats incl. Lucid embeds, federation), Phase-4 reports
(exceljs + playwright/pdfkit + `X-Report-Engine`), Phase-5 announcements + the
standalone outbox [worker](../backend-node-worker), and Phase-6 meetings (dual
state machine, optimistic locking, idempotency) + the realtime WebSocket.

Cross-cutting parity is complete too: security headers, CORS, `{detail}` errors,
and the **fixed-window rate limiter** (200/60s per IP, `429` + `Retry-After` +
`X-RateLimit-*`) — a faithful port of `middleware.py` (`src/common/rate-limit.ts`).

**Verified by:** `tsc` strict + `nest build` clean; all 114 routes mapped 1:1
with the Python routers; boot + WebSocket-handshake + rate-limit + gateway
smoke tests. A golden-response contract harness that diffs Node vs Python live
(analysis §16) lives in [packages/contract-tests](../../packages/contract-tests);
run it against both backends on the same seeded DB to *prove* body-level parity.
