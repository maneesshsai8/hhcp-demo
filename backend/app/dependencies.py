from fastapi import Request, HTTPException
import jwt

from app import config, database
from app.security import decode_access_token
from app.supabase_auth import verify_supabase_token


class CurrentUser:
    def __init__(self, user_id: str, active_tenant_id: str | None):
        self.user_id = user_id
        self.active_tenant_id = active_tenant_id


def _extract_token(request: Request) -> str:
    """httpOnly cookie first, Authorization: Bearer header as fallback."""
    token = request.cookies.get("access_token")
    if not token:
        authz = request.headers.get("authorization", "")
        if authz.startswith("Bearer "):
            token = authz.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return token


async def get_current_user(request: Request) -> CurrentUser:
    """
    Proves identity only — it does NOT decide what the user can see. That's left
    to Postgres RLS once we're in a scoped connection (Option B).

    Two auth providers, selected by config.AUTH_PROVIDER:
      - 'local'    : verify our own HS256 JWT (carries user_id + active_tenant_id)
      - 'supabase' : verify a Supabase ES256 token via JWKS, then map its `sub`
                     to our internal users.id (users.supabase_uid). Authorization
                     downstream is identical either way.
    """
    token = _extract_token(request)

    if config.AUTH_PROVIDER == "supabase":
        try:
            claims = verify_supabase_token(token)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid or expired Supabase token")

        sub = claims.get("sub")
        row = await database.pool().fetchrow(
            "SELECT id, is_active FROM users WHERE supabase_uid = $1::uuid", sub
        )
        if row is None:
            raise HTTPException(status_code=403, detail="No app user is linked to this Supabase account")
        if not row["is_active"]:
            raise HTTPException(status_code=403, detail="This account has been deactivated")
        # Active tenant isn't in the Supabase token — it's tracked as separate
        # app state (a header/cookie the switcher sets, validated against grants).
        active = request.cookies.get("active_tenant_id") or request.headers.get("x-active-tenant")
        return CurrentUser(user_id=str(row["id"]), active_tenant_id=active or None)

    # --- local provider (default) ---
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Access token expired — use /auth/refresh")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid access token")

    # Deactivation takes effect on the very next request (like a revoked grant).
    is_active = await database.pool().fetchval(
        "SELECT is_active FROM users WHERE id = $1", payload["user_id"]
    )
    if is_active is False:
        raise HTTPException(status_code=403, detail="This account has been deactivated")

    return CurrentUser(user_id=payload["user_id"], active_tenant_id=payload.get("active_tenant_id"))
