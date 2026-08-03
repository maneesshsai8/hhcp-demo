import secrets
import hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import (
    JWT_SECRET,
    JWT_ALGORITHM,
    ACCESS_TOKEN_LIFETIME_MINUTES,
    REFRESH_TOKEN_LIFETIME_DAYS,
)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(plain_password.encode(), password_hash.encode())


def hash_password(plain_password: str) -> str:
    return bcrypt.hashpw(plain_password.encode(), bcrypt.gensalt()).decode()


def create_access_token(user_id: str, active_tenant_id: str | None) -> str:
    """
    Note what's deliberately NOT in here: no accessible_tenant_ids[] array.
    Under Option B, authorization is re-checked against the live
    tenant_memberships table on every request — the token only needs to
    say who you are and which tenant you're currently "standing inside."
    """
    now = datetime.now(timezone.utc)
    payload = {
        "user_id": str(user_id),
        "active_tenant_id": str(active_tenant_id) if active_tenant_id else None,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_LIFETIME_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def generate_refresh_token() -> tuple[str, str, datetime]:
    """Returns (raw_token_to_send_to_client, hash_to_store_in_db, expires_at)."""
    raw_token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_LIFETIME_DAYS)
    return raw_token, token_hash, expires_at


def hash_refresh_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()
