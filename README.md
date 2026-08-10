# HHCP Business Operating System — Architecture Demo

A working local demo proving out the riskiest technical decisions from Project
Octane before real client work begins — built to mirror the bench team's own
"Suggested POC priority order."

This is **not** all 15 EOS modules. It's the hard architecture (auth, tenant
hierarchy, tiered RLS, tenant switching) proven end-to-end, plus 3 real
feature modules on top of it (Scorecards, Rocks, Issues) to show the pattern
actually supports real work.

---

## The story this demo seeds

```
Hidden Harbor Fund II
 +-- Restaurant A (PortCo)
 |     +-- Food Truck (Add-on)
 +-- Restaurant B (PortCo)
 +-- Restaurant C (PortCo)
```

| User | Access |
|---|---|
| `admin@hiddenharbor.com` | Fund Admin (Tier 1) — sees the entire portfolio, read-only rollup |
| `priya@hiddenharbor.com` | Ops QB — granted Restaurant A + Restaurant C. Should ALSO see Food Truck (cascaded down from Restaurant A) |
| `manager.b@restaurantb.com` | PortCo management — Restaurant B only |
| `manager.ft@restaurantA.com` | Add-on management — Food Truck only |

**Password for every demo account:** `Demo1234!`

---

## Tech stack actually used, and why

| Decision | This demo | Note |
|---|---|---|
| Database | PostgreSQL 16, installed natively via apt | Docker-in-Docker isn't available in the build sandbox; SQL/RLS design is identical either way |
| Authorization | **Option B** from the Foundation Tech Direction doc — a Postgres function (`user_accessible_tenants`) re-checked on every request via RLS, not baked into JWT claims | This is the team's own recommendation; proven directly (see Validation below) |
| Backend | FastAPI (Python), async, asyncpg | Original blueprint's choice. **The bench doc flagged Node/Express as an open, equally-valid alternative — still unresolved by the team.** Swapping frameworks would not change the schema or RLS design at all |
| Frontend | Next.js 14 (App Router) | Matches every proposal doc |
| Scorecard storage | Plain indexed, append-only Postgres table | TimescaleDB's hosted-extension availability was explicitly flagged as "needs verification" in the bench doc — this demo achieves the same immutability guarantee without depending on an unverified extension |
| Hosting | Runs entirely locally | Vercel/Supabase aren't reachable from the build sandbox; this proves the pattern, not the specific hosting target |
| Auth provider | Self-built JWT login (mirrors what Supabase Auth would do) | Same reason as hosting — this sandbox can't call out to Supabase's cloud |

---

## Running it yourself

### 1. Database
```bash
# Postgres 16 must be installed and running
sudo service postgresql start
sudo -u postgres psql -c "CREATE DATABASE hhcp_demo;"
sudo -u postgres psql -c "CREATE USER hhcp_app WITH PASSWORD 'demo_password_local_only';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hhcp_demo TO hhcp_app;"
sudo -u postgres psql -d hhcp_demo -c "GRANT ALL ON SCHEMA public TO hhcp_app;"
sudo -u postgres psql -d hhcp_demo -f packages/db/migrations/01_schema.sql
sudo -u postgres python3 packages/db/seeds/seed.py
```

### 2. Backend
```bash
cd backend
pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```
Then open **http://localhost:3000** — pick any demo account from the login
screen's quick-select list.

---

## What to actually click on, to see the architecture prove itself

1. **Log in as Priya.** The sidebar shows a literal hierarchy tree — that
   tree IS the tenant switcher. Notice Food Truck renders nested under
   Restaurant A automatically, and neither Restaurant B nor the Fund itself
   appear at all.
2. **Click "Restaurant A" in the tree.** The whole dashboard re-scopes —
   Scorecards, Rocks, and Issues all switch to Restaurant A's data. Look at
   "Outbound Sales Calls" — it's been off-track 3 weeks running, and there's
   a matching auto-created Issue on the Issues tab.
3. **Log out, log in as `manager.b@restaurantb.com`.** The tree shows only
   Restaurant B — there is no way, from the UI, to even discover Restaurant A
   or the Food Truck exist.
4. **Log in as `admin@hiddenharbor.com`.** An "All PortCos (rollup)" option
   appears at the top of the tree — the Tier 1 fund-wide view.

---

## Validation already run (via the real HTTP API, not just at the DB level)

All of these were run against the live backend before the frontend was even
built, mirroring the bench team's own POC priority order:

- ✅ Priya sees exactly Restaurant A, Restaurant C, and Food Truck (cascaded) — never Restaurant B or the raw Fund
- ✅ Restaurant B's manager sees only Restaurant B
- ✅ The fund admin sees the entire portfolio
- ✅ No session context set at all → zero rows returned (safe default-deny, not an error)
- ✅ Directly requesting another tenant's `tenant_id` in the URL as a bypass attempt → silently returns empty, RLS catches it regardless of what the API client asks for
- ✅ Switching to a tenant you don't have a grant for → rejected with 403
- ✅ **Revoking a grant takes effect on the very next request — using the exact same still-unexpired access token.** This is Option B's core "always correct, no stale access" claim, proven directly rather than just asserted
- ✅ 3 consecutive off-track Scorecard weeks auto-creates an Issue exactly once (no duplicates on a 4th off-track week)

---

## Known simplifications / things to flag back to the team

- **Backend framework (FastAPI vs. Node)** is still an open decision per the
  bench doc — this demo picked FastAPI, but nothing here is FastAPI-specific
  at the architecture level; the schema and RLS design port directly to Node
- **TimescaleDB vs. partitioning** — this demo uses neither (a plain indexed
  table, sufficient at demo scale); if Scorecard data volume ever becomes
  large enough to matter, that decision still needs to be made for real, per
  the bench doc's own "verify before you build on it" flag
- **Next.js dependency advisories**: this demo pins Next.js 14.2.35 (latest
  patched 14.x). A few high-severity advisories remain that require a Next 16
  upgrade (breaking change) to fully clear — none of the affected features
  (Image Optimizer, custom servers, i18n rewrites) are used here, but this is
  worth addressing before any real deployment
- **Meeting Concurrency, Vision/Values, Org Chart placeholder, Knowledge Base
  placeholder** — none of these are built in this demo; it deliberately
  focuses on proving the hardest architectural risk first
- The Lucidchart embedding pattern discussed earlier isn't implemented here
  either — this demo's scope stopped at the 3 core EOS modules once the
  authorization model was proven

---

## Project structure

```
hhcp-demo/
+-- database/
|   +-- 01_schema.sql      # tables, RLS policies, the authorization function
|   +-- seed.py            # the Fund/Restaurant A-B-C/Food Truck story
+-- backend/
|   +-- app/
|   |   +-- main.py            # FastAPI app, CORS, router registration
|   |   +-- config.py          # demo-only settings
|   |   +-- database.py        # connection pool + the SET LOCAL scoping helper
|   |   +-- security.py        # password hashing, JWT issue/verify
|   |   +-- dependencies.py    # extracts + verifies the JWT per request
|   |   +-- routers/
|   |       +-- auth.py            # login, refresh, switch-tenant, /me
|   |       +-- organizations.py   # PortCo provisioning + Tier 2 grants
|   |       +-- scorecards.py      # KPIs, weekly history, auto-issue trigger
|   |       +-- rocks.py
|   |       +-- issues.py
|   +-- requirements.txt
+-- frontend/
    +-- app/
    |   +-- login/page.js
    |   +-- dashboard/
    |       +-- layout.js         # the hierarchy-tree sidebar (the switcher)
    |       +-- scorecards/page.js
    |       +-- rocks/page.js
    |       +-- issues/page.js
    +-- lib/
    |   +-- api.js             # fetch wrapper, transparent token refresh
    |   +-- auth-context.js    # shared auth/tenant React state
    +-- package.json
```
