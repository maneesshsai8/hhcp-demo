# Architecture Notes & Phase-2 Gaps

This demo proves the hard parts of the HHCP Business Operating System — the
Fund → PortCo → Add-on hierarchy, tiered Row-Level Security, cross-tenant users,
role-based access, and the core EOS modules. A few things are deliberately
**simpler than the production blueprint**, either because this sandbox can't run
the real infrastructure or because full fidelity wasn't needed to prove the
architecture. This file records each choice honestly so nothing is mistaken for
production-ready.

Legend: ✅ done in the demo · 🟡 simplified · 🔭 Phase 2.

---

## 1. RBAC — role → action permissions ✅ (was a gap, now closed)

**Before:** authorization was purely *tenant-access* — RLS decided which tenants
you could see, but any user with access to a tenant could do anything in it. The
`role` columns (`lead_partner`, `deal_qb`, `ops_qb`, `portco_management`,
`addon_management`, `fund_admin`) existed but weren't enforced per action.

**Now:** a role→action matrix (`backend/app/permissions.py`) is enforced on every
create/edit/delete, layered on top of RLS:

| Role | view | create | edit | delete | provision |
|------|:--:|:--:|:--:|:--:|:--:|
| fund_admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| lead_partner / deal_qb / portco_management | ✅ | ✅ | ✅ | ✅ | — |
| ops_qb / addon_management | ✅ | ✅ | ✅ | — | — |

- Effective role is resolved by the SQL function `user_role_for_tenant()`
  (`database/05_rbac.sql`), which walks up the tenant tree so an add-on inherits
  the role of the PortCo grant that reaches it.
- The frontend mirrors the matrix (`lib/auth-context.js` → `can(action)`) to hide
  disallowed buttons, but **the backend is authoritative** — a forged request
  still gets a 403.

**🔭 Phase 2:** a full per-resource permission matrix (e.g. "ops_qb may edit
Scorecards but not the V/TO") rather than coarse action verbs. The current matrix
is a clean foundation for that.

---

## 2. API contracts ✅ / 🟡

- ✅ **Request bodies** are validated by Pydantic models.
- ✅ **Response models** now annotate the main read endpoints
  (`backend/app/schemas.py`), so Swagger (`/docs`) shows exact response shapes and
  outputs are validated.
- ✅ **Generated TypeScript client**: `npm run gen:api` regenerates
  `frontend/lib/api-types.d.ts` from the live OpenAPI schema
  (`openapi-typescript`). `frontend/lib/typed-api.js` exposes JSDoc-typed wrappers
  so the JS app gets editor intellisense/type-checking off the generated types.
- 🟡 Not every create/patch endpoint has a response model yet — the high-value
  read endpoints and `/auth/me` do. Same pattern extends to the rest.

---

## 3. Frontend language 🟡

The frontend is **JavaScript (Next.js App Router + React hooks)**, not TypeScript
— chosen for build speed on a demo. The generated `api-types.d.ts` + JSDoc typing
in `typed-api.js` give most of the type-safety benefit at the API boundary
without a full migration.

**🔭 Phase 2:** migrate `.js` → `.tsx`, add `tsconfig.json` + `typescript`/`@types`
deps, and consume the generated types directly instead of via JSDoc.

---

## 4. Business automation — synchronous vs event-driven 🟡

The "3 off-track weeks → auto-create an Issue" rule
(`backend/app/routers/scorecards.py`, in `add_score`) runs **synchronously inside
the request**. It works and is transactional, but it is *not* the event-driven
design from the original architecture doc.

**🔭 Phase 2 — the blueprint's Transactional Outbox + Kafka:**
1. On a scorecard write, insert a domain event into an `outbox` table **in the
   same DB transaction** (so the event can't be lost if the app crashes).
2. Debezium tails Postgres's WAL and publishes outbox rows to Kafka.
3. Independent workers consume events to create Issues, send notifications, update
   analytics — decoupled from the request path and independently scalable.

Not built here because this sandbox can't run Kafka/Debezium. The synchronous
version is the honest stand-in and keeps the same end result for the demo.

---

## 4b. Live meetings — real-time collaboration ✅ (was a gap, now built)

The L10 meeting runner is **multi-user live** over WebSockets
(`backend/app/realtime.py`, route `/ws/meetings/{id}`). An in-process room
manager tracks who's connected per meeting and broadcasts three message types:
`presence` (drives live "N of M present"), `section` (everyone follows the
facilitator through the agenda), and `refetch` (someone added an Issue or
toggled a To-Do → all clients reload that list). Verified with two distinct
users: a second participant joining flips the attendance counter live with no
refresh.

**🟡 Simplifications vs production:**
- **In-process room state** → won't span multiple backend instances. Production
  needs a shared bus (**Redis pub/sub**) so a broadcast reaches sockets on every
  instance.
- **WS auth via httpOnly cookie** — the access-token cookie is sent automatically
  on the WebSocket handshake (a query-param token remains as a non-browser
  fallback). This closed the earlier "token in the URL" gap.
- No conflict resolution / operational-transform for simultaneous edits — last
  write wins, which is fine for L10-style turn-taking but not for free-form
  co-editing.

---

## 5. Document & spreadsheet generation ✅ (was a gap, now built)

The blueprint described a document/export subsystem (Playwright HTML→PDF workers,
Pandas/OpenPyXL for Excel). Implemented for Scorecards:

- ✅ **Excel** — `GET /reports/scorecard.xlsx` builds a real `.xlsx` with OpenPyXL:
  KPI rows, one column per week, on-track (green) / off-track (red) cell fills,
  frozen header. (`backend/app/reports.py`)
- ✅ **PDF** — `GET /reports/scorecard.pdf` renders a styled HTML template with
  **headless Chromium via Playwright** (the blueprint's exact approach), with a
  **pure-Python fpdf2 fallback** if the browser can't launch. The response's
  `X-Report-Engine` header reports which engine was used.
- Both endpoints are RBAC `view`-gated and RLS-scoped. Frontend has "Export
  Excel / Export PDF" buttons on the Scorecard page (auth-aware blob download).

**🟡 Simplification vs production:** generation runs **inline in the request**,
not on background workers. At scale, big exports would be handed to a worker
queue (or the Kafka consumers in §4) so a large PDF never blocks the request
thread — same code, moved off the request path.

---

## 6. API gateway 🟡 (partial) / 🔭

**Now (in-process taste):** `backend/app/middleware.py` adds
- **Rate limiting** — fixed-window per-client-IP limiter (200 req/60s here),
  returning `429` + `Retry-After`, and `X-RateLimit-Limit/Remaining` headers.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` on every response.

**🔭 Phase 2 — a real edge gateway** (nginx / Kong / cloud API Gateway) in front
of the app, owning: TLS termination, centralized routing/versioning, auth token
validation at the edge, global + per-route rate limiting backed by Redis (not
in-process memory), request/response shaping, WAF, and observability. The
in-process version proves the behavior; production moves it to infrastructure so
it's shared across service instances and survives restarts.

---

## 7. OAuth2 / SSO provider 🔭

The demo uses a **self-built JWT flow** (`backend/app/security.py`): login →
short-lived access token + long-lived refresh token, verified per request. This
mirrors the *token mechanics* of a real provider but issues tokens itself.

**🔭 Phase 2 — real OAuth2 / OIDC** (the blueprint's Google / Microsoft SSO):
1. `GET /auth/oauth/{provider}/start` → redirect to the IdP's authorize URL
   (PKCE, state).
2. IdP redirects back to `GET /auth/oauth/{provider}/callback?code=...`.
3. Backend exchanges the code for the provider's tokens over a server-to-server
   call, verifies the ID token (issuer, audience, signature via JWKS), and
   upserts the user.
4. The app then issues its **own** session tokens — so the rest of the system
   (RLS, RBAC, tenant switching) is unchanged; only the *identity source* moves
   from a local password to the IdP.

Not built here because it requires external IdP client credentials, registered
callback URLs, and outbound network to the provider — none of which exist in the
local sandbox. The clean seam is that everything downstream of "issue our session
token" already works, so dropping in OAuth2 is additive, not a rewrite.

---

## 8. Other deliberate simplifications (from earlier doc analysis)

| Area | Demo (🟡) | Production (🔭) |
|------|-----------|-----------------|
| Auth provider | Self-built JWT (login → access + refresh tokens) | Supabase Auth / SSO (Google, Microsoft) |
| Scorecard storage | Plain indexed append-only table | TimescaleDB hypertable (needs the extension; verify Supabase plan supports it) |
| Scorecard rollups | Weekly only | Monthly / Quarterly / Annual via `time_bucket()` |
| Org Chart | Native seats tree (Accountability Chart module) | Also: secure Lucidchart embed (cookie- or token-based) per the spike doc |
| Hosting | All local (Postgres + FastAPI + Next) | Vercel + Supabase, cloud-native autoscaling |
| Backend framework | FastAPI (Python) | Unresolved in the bench doc (FastAPI vs Node) — nothing here is FastAPI-specific at the architecture level |

---

## What is genuinely production-shaped in the demo

These are **not** simplified — they're the real design and are proven with tests:

- Tiered Row-Level Security with the recursive `parent_id` tree-walk (cascading
  access, sibling isolation, safe default-deny).
- Option B authorization — access re-checked against the live grant list on every
  request, so revocation takes effect on the very next request (not on token
  refresh).
- Cross-tenant users + tenant switching with server-side re-validation.
- PortCo provisioning, user/team management, and access grants.
- The full EOS module set with CRUD: Scorecards, Rocks, To-Dos, Issues, Meetings,
  Accountability Chart.
