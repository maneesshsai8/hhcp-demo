# Supabase Auth for login + database-driven authorization

The bench doc's recommended split, implemented and proven:

- **Authentication (who you are)** → **Supabase Auth**. Supabase issues + refreshes
  the JWT (signed with an **ES256** asymmetric key).
- **Authorization (what you can see/do)** → **our Postgres RLS + `tenant_memberships`**
  (Option B), completely unchanged. Supabase only tells us the user's `sub`.

It's **flag-gated**, so the local self-issued-JWT auth still works for offline dev.

## Switching it on

| Flag | File | Values |
|------|------|--------|
| `AUTH_PROVIDER` | `backend/.env` | `local` \| `supabase` |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `frontend/.env.local` | `local` \| `supabase` |

`backend/.env` (git-ignored) also needs:
```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon>            # also in frontend/.env.local as NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_SERVICE_ROLE_KEY=<secret>  # only for user provisioning; keep secret, never commit
```
After changing `NEXT_PUBLIC_*`, restart the frontend and clear `.next` (`rm -rf frontend/.next`) — Next inlines those at compile time.

## How it works (httpOnly, backend-mediated)

supabase-js uses an **in-memory** store (no localStorage), and the real session lives
in the backend's httpOnly cookies — so JavaScript never holds the token.

1. **Login** — `frontend/lib/api.js` calls `supabase.auth.signInWithPassword()`, then
   POSTs the tokens to **`POST /auth/supabase-session`**, which verifies the access token
   (JWKS) and sets `access_token` + `sb_refresh_token` as **httpOnly cookies**.
2. **Every request** — sends the cookie (`credentials: "include"`); no Bearer header.
   Cookies are per-host (port-agnostic), so they reach the FastAPI backend on `:8000`.
3. **Verify** — `backend/app/supabase_auth.py` verifies the cookie's token against the
   project **JWKS** (ES256, public key — no shared secret), checking `aud` + issuer.
4. **Map** — `get_current_user` looks up the internal user by `users.supabase_uid = sub`,
   then sets `app.current_user_id` exactly as before → **RLS is unchanged**.
5. **Refresh** — on a 401, the frontend calls **`POST /auth/supabase-refresh`**; the backend
   uses the httpOnly `sb_refresh_token` to get a fresh session from Supabase and re-sets the
   cookie. The browser never touches refresh.
6. **Active tenant** — not in the token; a non-secret tenant id kept client-side and sent
   via the `X-Active-Tenant` header (still validated by RLS on every query).

## OAuth / SSO (Google, Microsoft)

The code is wired; enabling a provider is a dashboard step (needs an OAuth app you own).

**Flow:** login page → `supabase.auth.signInWithOAuth({provider})` (implicit flow) →
provider consent → back to **`/auth/callback`** → read tokens from the URL `#hash` →
handed to `/auth/supabase-session` (httpOnly cookie, token scrubbed from the URL) → dashboard.

**Invite-only (no self-signup):** on first OAuth login the account is linked to an
existing `users` row **by email**. If no `users` row has that email, login is
**rejected** (403) — an admin must create the user first. So OAuth authenticates
*who* you are, but you must already be provisioned to get in.

**Enable Google:**
1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID → Web**.
   Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`. Copy Client ID + Secret.
2. Supabase → **Authentication → Providers → Google** → enable, paste Client ID + Secret.
3. Supabase → **Authentication → URL Configuration** → add redirect URL
   `http://localhost:3002/auth/callback` and site URL `http://localhost:3002`.
4. (Optional) pre-seed a `users` row with your Google email + `is_fund_admin=true` so the
   email-link gives you access on first OAuth login.

**Microsoft** is identical with an Azure AD app registration and the `azure` provider.

## Provisioning users

`users.supabase_uid` links our row to the Supabase account. To create + link all demo
users (auto-confirmed, password `Demo1234!`):
```
backend/venv/bin/python database/migrate_users_to_supabase.py
```
(idempotent — reuses existing Supabase accounts). Needs `SUPABASE_SERVICE_ROLE_KEY`.

## Production hardening
- ✅ **httpOnly cookies — done.** The token is in a backend-set httpOnly cookie, not
  localStorage (verified: `document.cookie` can't read it, nothing sensitive in localStorage).
  Note: `@supabase/ssr` alone wouldn't achieve this here — its *browser* client writes
  JS-readable cookies; only a server (our FastAPI) can set httpOnly, which is what we do.
- 🔭 **Secrets:** set `secure=True` cookies (https), rotate the `service_role` key, keep it server-only.
- 🔭 **Active-tenant:** move from a client header to a signed/validated value for stricter control.
