from fastapi import Header, HTTPException
import jwt

from app.security import decode_access_token


class CurrentUser:
    def __init__(self, user_id: str, active_tenant_id: str | None):
        self.user_id = user_id
        self.active_tenant_id = active_tenant_id


async def get_current_user(authorization: str = Header(default=None)) -> CurrentUser:
    """
    Every protected route depends on this. It only proves identity — it does
    NOT decide what the user can see. That decision is left entirely to
    Postgres's RLS policies once we're inside a scoped connection, per
    Option B from the Foundation Tech Direction doc.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Access token expired — use /auth/refresh")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid access token")

    return CurrentUser(user_id=payload["user_id"], active_tenant_id=payload.get("active_tenant_id"))
