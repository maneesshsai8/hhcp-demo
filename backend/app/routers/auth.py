from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.security import (
    verify_password,
    create_access_token,
    generate_refresh_token,
    hash_refresh_token,
)
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/auth", tags=["auth"])


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
            SELECT o.id, o.name, o.tenant_type, o.parent_tenant_id
            FROM organizations o
            ORDER BY o.tenant_type, o.name
            """
        )
        is_fund_admin = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM fund_roles WHERE user_id = $1 AND role = 'fund_admin')",
            user_id,
        )
        return [dict(r) for r in rows], is_fund_admin


@router.post("/login")
async def login(body: LoginRequest):
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

    return {
        "access_token": access_token,
        "refresh_token": raw_refresh,
        "user": {"id": user_id, "name": row["name"], "email": body.email, "is_fund_admin": is_fund_admin},
        "accessible_tenants": tenants,
        "active_tenant_id": str(default_active_tenant) if default_active_tenant else None,
    }


@router.post("/refresh")
async def refresh(body: RefreshRequest):
    token_hash = hash_refresh_token(body.refresh_token)

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
    return {
        "access_token": access_token,
        "accessible_tenants": tenants,
        "active_tenant_id": str(default_active_tenant) if default_active_tenant else None,
    }


@router.post("/switch-tenant")
async def switch_tenant(body: SwitchTenantRequest, current_user: CurrentUser = Depends(get_current_user)):
    # The one rule this endpoint exists to enforce: the client can ASK to
    # switch to any tenant_id it wants, but the server only approves it if
    # a live check against tenant_memberships (via the same authorization
    # function everything else uses) says yes.
    async with get_scoped_connection(current_user.user_id) as conn:
        if body.tenant_id is None:
            # Rollup mode is only for Tier 1 fund-level staff.
            allowed = await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM fund_roles WHERE user_id = $1)", current_user.user_id
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
    return {"access_token": new_access_token, "active_tenant_id": body.tenant_id}


@router.get("/me")
async def me(current_user: CurrentUser = Depends(get_current_user)):
    tenants, is_fund_admin = await _accessible_tenants_for(current_user.user_id)
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow("SELECT id, name, email FROM users WHERE id = $1", current_user.user_id)
    return {
        "user": {**dict(row), "id": str(row["id"]), "is_fund_admin": is_fund_admin},
        "accessible_tenants": tenants,
        "active_tenant_id": current_user.active_tenant_id,
    }
