"""
Verify a Supabase-issued access token — the "Supabase Auth for login" half.

Supabase signs tokens with an asymmetric ES256 key exposed at the project's
JWKS URL, so we verify with the *public* key (no shared secret needed). The
signing keys are fetched once and cached by PyJWKClient.

Authorization is unchanged: once we trust the token's `sub`, everything
downstream (RLS, tenant_memberships, the tenant tree-walk) works exactly as
before. Supabase only tells us *who* the user is.
"""
import ssl

import certifi
import jwt
from jwt import PyJWKClient

from app import config

_ssl_ctx = ssl.create_default_context(cafile=certifi.where())
_jwks_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        if not config.SUPABASE_JWKS_URL:
            raise RuntimeError("SUPABASE_JWKS_URL is not configured")
        _jwks_client = PyJWKClient(config.SUPABASE_JWKS_URL, ssl_context=_ssl_ctx, cache_keys=True)
    return _jwks_client


def verify_supabase_token(token: str) -> dict:
    """Return the verified claims, or raise a jwt exception if invalid/expired."""
    signing_key = _client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256"],
        audience="authenticated",
        issuer=f"{config.SUPABASE_URL}/auth/v1",
    )


def refresh_session(refresh_token: str) -> dict:
    """Exchange a Supabase refresh token for a fresh session (access + refresh)."""
    import json
    import urllib.request

    body = json.dumps({"refresh_token": refresh_token}).encode()
    req = urllib.request.Request(
        f"{config.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        data=body,
        headers={"apikey": config.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=_ssl_ctx) as r:
        return json.loads(r.read().decode())
