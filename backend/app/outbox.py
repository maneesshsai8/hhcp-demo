"""
Transactional outbox writer.

`emit()` INSERTs a durable event row on the SAME connection/transaction as the
domain change that produced it. Because get_scoped_connection() wraps each
request in a single transaction, the domain write and its outbox event either
both commit or both roll back — there is no window where the meeting is
completed but the event was lost, or vice-versa.

A separate worker process (app/workers/outbox_worker.py) drains the table after
commit and fans out to summaries / notifications / calendar sync. Realtime
Broadcast, when adopted, is published from that worker — never from the client.
"""
import json


async def emit(conn, event_type: str, *, aggregate_id: str, tenant_id: str | None = None,
               payload: dict | None = None, event_version: int = 1,
               aggregate_type: str = "meeting") -> str:
    """Append one event to the outbox in the caller's transaction. Returns event_id."""
    row = await conn.fetchrow(
        """
        INSERT INTO meeting_outbox (event_type, event_version, aggregate_type, aggregate_id, tenant_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING event_id
        """,
        event_type, event_version, aggregate_type, aggregate_id,
        (tenant_id if tenant_id else None), json.dumps(payload or {}),
    )
    return str(row["event_id"])
