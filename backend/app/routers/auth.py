from fastapi import APIRouter, HTTPException, Depends, Response, Request
from pydantic import BaseModel

from app.database import get_scoped_connection
from app import schemas, audit
from app.config import ACCESS_TOKEN_LIFETIME_MINUTES, REFRESH_TOKEN_LIFETIME_DAYS
from app.security import (
    verify_password,
    create_access_token,
    generate_refresh_token,
    hash_refresh_token,
)
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/auth", tags=["auth"])

# httpOnly cookies: the browser stores these and JavaScript can't read them, so
# an XSS bug can't exfiltrate the token (the whole point of moving off
# localStorage). secure=False only because this demo runs on http://localhost —
# in production set secure=True (https-only) and add a CSRF token alongside
# SameSite for state-changing requests.
_COOKIE = dict(httponly=True, samesite="lax", secure=False, path="/")


def _set_access_cookie(response: Response, token: str):
    response.set_cookie("access_token", token, max_age=ACCESS_TOKEN_LIFETIME_MINUTES * 60, **_COOKIE)


def _set_refresh_cookie(response: Response, token: str):
    response.set_cookie("refresh_token", token, max_age=REFRESH_TOKEN_LIFETIME_DAYS * 24 * 3600, **_COOKIE)


def _clear_auth_cookies(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    response.delete_cookie("sb_refresh_token", path="/")


class SupabaseSessionRequest(BaseModel):
    access_token: str
    refresh_token: str


def _store_supabase_session(response: Response, access_token: str, refresh_token: str):
    """Put a Supabase session into httpOnly cookies so JS never holds the token
    (cookies are per-host, not per-port, so they also reach this backend)."""
    import jwt as _jwt
    try:
        exp = _jwt.decode(access_token, options={"verify_signature": False}).get("exp", 0)
        import time
        max_age = max(60, int(exp - time.time()))
    except Exception:
        max_age = 3600
    response.set_cookie("access_token", access_token, max_age=max_age, **_COOKIE)
    response.set_cookie("sb_refresh_token", refresh_token, max_age=30 * 24 * 3600, **_COOKIE)


class LoginRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class SwitchTenantRequest(BaseModel):
    tenant_id: str | None = None


async def _accessible_tenants_for(user_id: str):
    """Live lookup — always the current source of truth, never a cached claim."""
    async with get_scoped_connection(user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT o.id, o.name, o.tenant_type, o.parent_tenant_id,
                   user_role_for_tenant($1, o.id) AS role
            FROM organizations o
            ORDER BY o.tenant_type, o.name
            """,
            user_id,
        )
        is_fund_admin = await conn.fetchval(
            "SELECT COALESCE(is_fund_admin, false) FROM users WHERE id = $1",
            user_id,
        )
        return [dict(r) for r in rows], is_fund_admin


@router.post("/login")
async def login(body: LoginRequest, response: Response):
    # Step 1: look up the user. `users` has no RLS — we don't know who this
    # is yet, so there's nothing to scope by. This is the ONLY query in the
    # app that runs without an app.current_user_id set.
    async with get_scoped_connection(None) as conn:
        row = await conn.fetchrow(
            "SELECT id, password_hash, name FROM users WHERE email = $1", body.email
        )

    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_id = str(row["id"])

    # Step 2: NOW that we know who they are, look up what they can actually
    # see — a live database read, never trusted from anywhere else.
    tenants, is_fund_admin = await _accessible_tenants_for(user_id)

    # Fund admins default into "rollup mode" (no single active tenant).
    # Everyone else defaults into their first granted tenant.
    default_active_tenant = None if is_fund_admin else (tenants[0]["id"] if tenants else None)

    access_token = create_access_token(user_id, str(default_active_tenant) if default_active_tenant else None)

    raw_refresh, refresh_hash, expires_at = generate_refresh_token()
    async with get_scoped_connection(user_id) as conn:
        await conn.execute(
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
            user_id, refresh_hash, expires_at,
        )
        await audit.log(conn, user_id, "login", entity_type="user", entity_id=user_id, detail="password")

    # Tokens go into httpOnly cookies, not the response body — the client never
    # sees or handles them.
    _set_access_cookie(response, access_token)
    _set_refresh_cookie(response, raw_refresh)

    return {
        "user": {"id": user_id, "name": row["name"], "email": body.email, "is_fund_admin": is_fund_admin},
        "accessible_tenants": tenants,
        "active_tenant_id": str(default_active_tenant) if default_active_tenant else None,
    }


@router.post("/refresh")
async def refresh(request: Request, response: Response, body: RefreshRequest | None = None):
    # Prefer the httpOnly cookie; fall back to a body token for API clients/tests.
    raw_refresh = request.cookies.get("refresh_token") or (body.refresh_token if body else None)
    if not raw_refresh:
        raise HTTPException(status_code=401, detail="No refresh token")
    token_hash = hash_refresh_token(raw_refresh)

    async with get_scoped_connection(None) as conn:
        row = await conn.fetchrow(
            """
            SELECT user_id FROM refresh_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
            """,
            token_hash,
        )

    if row is None:
        raise HTTPException(status_code=401, detail="Refresh token invalid, expired, or revoked")

    user_id = str(row["user_id"])

    # Re-check live access on every refresh too — if a grant was revoked
    # while this token was still valid, this is where it gets caught.
    tenants, is_fund_admin = await _accessible_tenants_for(user_id)
    default_active_tenant = None if is_fund_admin else (tenants[0]["id"] if tenants else None)

    access_token = create_access_token(user_id, str(default_active_tenant) if default_active_tenant else None)
    _set_access_cookie(response, access_token)
    return {
        "accessible_tenants": tenants,
        "active_tenant_id": str(default_active_tenant) if default_active_tenant else None,
    }


@router.post("/switch-tenant")
async def switch_tenant(body: SwitchTenantRequest, response: Response, current_user: CurrentUser = Depends(get_current_user)):
    # The one rule this endpoint exists to enforce: the client can ASK to
    # switch to any tenant_id it wants, but the server only approves it if
    # a live check against tenant_memberships (via the same authorization
    # function everything else uses) says yes.
    async with get_scoped_connection(current_user.user_id) as conn:
        if body.tenant_id is None:
            # Rollup mode is only for Tier 1 fund-level staff.
            allowed = await conn.fetchval(
                "SELECT COALESCE(is_fund_admin, false) FROM users WHERE id = $1", current_user.user_id
            )
        else:
            allowed = await conn.fetchval(
                """
                SELECT EXISTS (
                    SELECT 1 FROM user_accessible_tenants($1::uuid) WHERE tenant_id = $2::uuid
                )
                """,
                current_user.user_id, body.tenant_id,
            )

    if not allowed:
        raise HTTPException(status_code=403, detail="You don't have access to that tenant")

    new_access_token = create_access_token(current_user.user_id, body.tenant_id)
    _set_access_cookie(response, new_access_token)
    return {"active_tenant_id": body.tenant_id}


@router.post("/logout")
async def logout(request: Request, response: Response):
    """Revoke the refresh token server-side and clear both httpOnly cookies.
    (The client can't clear httpOnly cookies itself — the server must.)"""
    raw_refresh = request.cookies.get("refresh_token")
    if raw_refresh:
        token_hash = hash_refresh_token(raw_refresh)
        async with get_scoped_connection(None) as conn:
            await conn.execute(
                "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
                token_hash,
            )
    _clear_auth_cookies(response)
    return {"ok": True}


async def _ensure_app_user(claims: dict):
    """Invite-only: a user must be pre-created by an admin before they can log in.
      - already linked by supabase_uid → ok
      - an unlinked row with the same email → link it (first OAuth login) → ok
      - otherwise → REJECT (no self-signup; account must exist first)
    users has no RLS, so this runs on an unscoped connection.
    """
    sub = claims.get("sub")
    email = (claims.get("email") or "").lower()
    async with get_scoped_connection(None) as conn:
        linked = await conn.fetchval("SELECT id FROM users WHERE supabase_uid = $1", sub)
        if linked:
            return str(linked)
        existing = await conn.fetchval(
            "SELECT id FROM users WHERE lower(email) = $1 AND supabase_uid IS NULL", email
        )
        if existing:
            await conn.execute("UPDATE users SET supabase_uid = $1 WHERE id = $2", sub, existing)
            return str(existing)
    raise HTTPException(
        status_code=403,
        detail="This account isn't set up yet. Ask an administrator to create your user first.",
    )


@router.post("/supabase-session")
async def supabase_session(body: SupabaseSessionRequest, response: Response):
    """Called by the frontend right after a Supabase login (password OR OAuth).
    Verifies the token, provisions/links the app user, then stores the session in
    httpOnly cookies — so the token lives in a cookie JS can't read."""
    from app.supabase_auth import verify_supabase_token
    try:
        claims = verify_supabase_token(body.access_token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Supabase token")
    uid = await _ensure_app_user(claims)
    _store_supabase_session(response, body.access_token, body.refresh_token)
    if uid:
        async with get_scoped_connection(uid) as conn:
            await audit.log(conn, uid, "login", entity_type="user", entity_id=uid, detail="supabase")
    return {"ok": True}


@router.post("/supabase-refresh")
async def supabase_refresh(request: Request, response: Response):
    """Rotate an expired Supabase access cookie using the httpOnly refresh cookie —
    the backend owns refresh, the browser never touches the tokens."""
    from app.supabase_auth import refresh_session
    rt = request.cookies.get("sb_refresh_token")
    if not rt:
        raise HTTPException(status_code=401, detail="No Supabase refresh token")
    try:
        data = refresh_session(rt)
    except Exception:
        raise HTTPException(status_code=401, detail="Supabase refresh failed")
    _store_supabase_session(response, data["access_token"], data["refresh_token"])
    return {"ok": True}


@router.get("/realtime-token")
async def realtime_token(current_user: CurrentUser = Depends(get_current_user)):
    """Mint a SHORT-LIVED token that authorizes the caller to join Supabase
    Realtime private channels for exactly the tenants they can access.

    The authorization decision is computed here (the same live
    user_accessible_tenants check everything else uses) and carried in the
    token's claims — because a Realtime RLS policy can't reach our app DB
    (see database/realtime_authorization.sql). Channels are namespaced
    `tenant:<tenant_id>:…`; the policy matches the topic's tenant against
    `app_tenants` (or `app_fund_admin`). No claim → no subscription.
    """
    import time
    import jwt as _jwt
    from app import config

    if not config.SUPABASE_REALTIME_SIGNING_SECRET:
        raise HTTPException(status_code=501, detail="Realtime token signing is not configured")

    async with get_scoped_connection(current_user.user_id) as conn:
        is_fund_admin = await conn.fetchval(
            "SELECT COALESCE(is_fund_admin, false) FROM users WHERE id = $1", current_user.user_id)
        tenant_ids = [] if is_fund_admin else [
            str(r["tenant_id"]) for r in await conn.fetch(
                "SELECT tenant_id FROM user_accessible_tenants($1::uuid)", current_user.user_id)]

    ttl = 3600  # 1h; the client refetches on expiry/reconnect
    claims = {
        "sub": str(current_user.user_id),
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + ttl,
        "app_fund_admin": bool(is_fund_admin),
        "app_tenants": tenant_ids,
    }
    token = _jwt.encode(claims, config.SUPABASE_REALTIME_SIGNING_SECRET, algorithm="HS256")
    return {"token": token, "expires_in": ttl, "fund_admin": bool(is_fund_admin)}


@router.get("/me", response_model=schemas.MeResponse)
async def me(current_user: CurrentUser = Depends(get_current_user)):
    tenants, is_fund_admin = await _accessible_tenants_for(current_user.user_id)
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow("SELECT id, name, email, COALESCE(is_fund_viewer, false) AS is_fund_viewer FROM users WHERE id = $1", current_user.user_id)
    return {
        "user": {**dict(row), "id": str(row["id"]), "is_fund_admin": is_fund_admin},
        "accessible_tenants": tenants,
        "active_tenant_id": current_user.active_tenant_id,
    }
