"""
Lucidchart token-based embeds (Approach 2).

The whole point: viewers see the chart WITHOUT a Lucid account and never hit a
login prompt, because our backend mints a short-lived embed session token using
OAuth credentials that never leave the server.

Flow (per Lucid's Embed API — https://developer.lucid.co/docs/tutorial-token-embeds):
  1. refresh_token (stored in .env, obtained once via scripts/lucid_oauth.py)
     --> access_token          POST https://api.lucid.co/oauth2/token
  2. access_token + embedId    --> short-lived embed session token
                               POST https://api.lucid.co/embeds/token
  3. iframe src = https://lucid.app/embeds?token=<session token>

Tokens are single-use / short-lived, so we mint a fresh one on every view.
"""
import httpx

from app import config

OAUTH_TOKEN_URL = "https://api.lucid.co/oauth2/token"
EMBED_TOKEN_URL = "https://api.lucid.co/embeds/token"
EMBED_IFRAME_BASE = "https://lucid.app/embeds"


def is_configured() -> bool:
    return bool(config.LUCID_CLIENT_ID and config.LUCID_CLIENT_SECRET and config.LUCID_REFRESH_TOKEN)


async def _access_token() -> str:
    """Exchange the stored refresh token for a fresh access token."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(OAUTH_TOKEN_URL, json={
            "grant_type": "refresh_token",
            "refresh_token": config.LUCID_REFRESH_TOKEN,
            "client_id": config.LUCID_CLIENT_ID,
            "client_secret": config.LUCID_CLIENT_SECRET,
        })
    resp.raise_for_status()
    return resp.json()["access_token"]


def _extract_token(payload: dict) -> str | None:
    # the docs don't pin the field name, so accept the common shapes
    for k in ("token", "sessionToken", "embedSessionToken", "embed_session_token"):
        if payload.get(k):
            return payload[k]
    return None


async def mint_embed_url(embed_id: str) -> str:
    """Return a ready-to-iframe URL carrying a fresh short-lived session token."""
    access = await _access_token()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(EMBED_TOKEN_URL,
            headers={
                "Authorization": f"Bearer {access}",
                "Lucid-Api-Version": config.LUCID_API_VERSION,
                "Content-Type": "application/json",
            },
            json={"origin": config.LUCID_EMBED_ORIGIN, "embedId": embed_id},
        )
    resp.raise_for_status()
    token = _extract_token(resp.json())
    if not token:
        raise RuntimeError("Lucid embed token endpoint returned no token field")
    return f"{EMBED_IFRAME_BASE}?token={token}"
