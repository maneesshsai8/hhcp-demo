"""
Idempotency for retryable commands (start / complete meeting, inline issue/todo).

Usage inside an endpoint, on the request's scoped connection:

    prior = await idempotency.lookup(conn, user_id, "meeting.complete", key, body_bytes)
    if prior is not None:
        return prior            # replay the original response, no duplicate effect
    ... do the work ...
    await idempotency.save(conn, user_id, "meeting.complete", key, body_bytes,
                           tenant_id=tenant_id, status=200, response=result)
    return result

Because the whole request is one transaction, the idempotency row commits
atomically with the effect. A concurrent duplicate (same user+command+key) hits
the UNIQUE constraint and is surfaced as a 409 by lookup()'s caller. Reusing a
key with a *different* payload is a 409 ("IdempotencyConflict").
"""
import hashlib

from fastapi import HTTPException

_TTL_HOURS = 48


def _hash(body: bytes | None) -> str:
    return hashlib.sha256(body or b"").hexdigest()


async def lookup(conn, user_id: str, command: str, key: str | None, body: bytes | None):
    """Return the stored response dict if this exact command was already run,
    else None. Raises 409 if the key was used with a different payload."""
    if not key:
        return None
    row = await conn.fetchrow(
        "SELECT request_hash, response_body FROM meeting_idempotency "
        "WHERE user_id = $1 AND command_name = $2 AND idempotency_key = $3",
        user_id, command, key,
    )
    if row is None:
        return None
    if row["request_hash"] != _hash(body):
        raise HTTPException(status_code=409, detail="Idempotency-Key reused with a different request")
    import json
    return json.loads(row["response_body"]) if isinstance(row["response_body"], str) else row["response_body"]


async def save(conn, user_id: str, command: str, key: str | None, body: bytes | None,
               *, tenant_id: str | None = None, status: int = 200, response: dict | None = None):
    """Persist the command's response so a retry replays it. No-op without a key."""
    if not key:
        return
    import json
    await conn.execute(
        """
        INSERT INTO meeting_idempotency
            (tenant_id, user_id, command_name, idempotency_key, request_hash, response_status, response_body, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + ($8 || ' hours')::interval)
        ON CONFLICT (user_id, command_name, idempotency_key) DO NOTHING
        """,
        (tenant_id if tenant_id else None), user_id, command, key, _hash(body),
        status, json.dumps(response or {}), str(_TTL_HOURS),
    )
