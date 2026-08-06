"""
Outbox worker — the durable, out-of-request half of the meetings backbone.

A SEPARATE process from the FastAPI app (run with `python -m app.workers.runner`).
It drains meeting_outbox with `FOR UPDATE SKIP LOCKED` so many workers can run
without double-processing, regenerates/publishes the post-meeting summary for
`meeting.completed`, and hands other events to notification / calendar stubs.

Design choices (documented, deliberate):
  * PostgreSQL-backed queue, not Kafka/Redis — the repo uses neither and a
    SKIP-LOCKED poller is sufficient for this volume. The handler dispatch is
    structured so a managed queue can replace the poller later.
  * Success path is one transaction: claim + do the work + mark PROCESSED commit
    together, so a crash mid-work simply leaves the row claimable again.
  * On failure the claim is rolled back and the error/backoff is recorded on a
    fresh connection, then the row retries after an exponential delay.
  * The worker has no user context, so for events that must read tenant data
    (summary regeneration) it sets app.current_user_id to the event's actorId —
    the user who triggered it, who by construction can see that tenant. No
    superuser / RLS bypass required.

Realtime note: when Supabase Realtime Broadcast is adopted, this worker is where
`summary.generated` (and the other confirmed events) get published — never the
client. Today it logs the publish intent.
"""
import asyncio
import json
import logging

import asyncpg

from app.config import DATABASE_URL
from app import meeting_summary, realtime_broadcast

log = logging.getLogger("meetings.outbox")

_MAX_ATTEMPTS = 8
_POLL_IDLE_SECONDS = 0.5   # snappy live-meeting propagation; a burst drains with no sleep
_STUCK_PROCESSING_MINUTES = 5   # reaper threshold for crashed in-flight rows


def _backoff_seconds(attempt: int) -> int:
    return min(300, 2 ** attempt)   # 2,4,8,... capped at 5 min


async def _publish_realtime(event_type: str, payload: dict):
    """Publish a confirmed event to the meeting's Supabase Realtime channel.
    Best-effort: a failed publish never fails the outbox row (clients recover
    via /live-state)."""
    meeting_id = payload.get("meetingId")
    if not meeting_id:
        return
    ok = await realtime_broadcast.broadcast(meeting_id, event_type, payload)
    log.info("realtime.publish %s meeting=%s ok=%s", event_type, meeting_id, ok)


async def _notify(event_type: str, payload: dict):
    """Placeholder notification hook (reuse app.mailer / announcements later)."""
    log.info("notify %s meeting=%s", event_type, payload.get("meetingId"))


async def _handle(conn, row) -> None:
    """Process one claimed outbox row inside the claim transaction."""
    event_type = row["event_type"]
    payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else (row["payload"] or {})
    meeting_id = payload.get("meetingId") or str(row["aggregate_id"])

    if event_type == "meeting.completed":
        actor_id = payload.get("actorId")
        if actor_id:
            # scope RLS to the completer so we can read the meeting's tenant data
            await conn.execute("SELECT set_config('app.current_user_id', $1, true)", actor_id)
            summary = await meeting_summary.build_summary(conn, meeting_id)
            await conn.execute("UPDATE meetings SET summary = $2::jsonb WHERE id = $1",
                               meeting_id, json.dumps(summary))
            log.info("summary regenerated meeting=%s rating=%s todos=%d",
                     meeting_id, summary.get("rating"), len(summary.get("todos_created", [])))
        await _publish_realtime("summary.generated", payload)
        await _notify("meeting.completed", payload)
    elif event_type == "calendar.create":
        from app import calendar as cal
        actor_id, provider_name = payload.get("actorId"), payload.get("provider")
        if actor_id:
            await conn.execute("SELECT set_config('app.current_user_id', $1, true)", actor_id)
        prov = cal.get_provider(provider_name)
        if prov is None:
            await conn.execute(
                "UPDATE meeting_calendar_links SET sync_status='failed', last_error='unknown provider', "
                "updated_at=now() WHERE meeting_id=$1 AND provider=$2", meeting_id, provider_name)
        else:
            try:
                res = await prov.create_event(title=payload.get("title"), description=None,
                                              start=payload.get("scheduledAt"), end=None, attendees=[])
                await conn.execute(
                    "UPDATE meeting_calendar_links SET sync_status='synced', external_event_id=$3, "
                    "last_synced_at=now(), last_error=NULL, updated_at=now() WHERE meeting_id=$1 AND provider=$2",
                    meeting_id, provider_name, res.get("external_event_id"))
                log.info("calendar synced meeting=%s provider=%s", meeting_id, provider_name)
            except cal.CalendarNotConfigured as e:
                # expected in the demo: record and move on (do NOT fail/retry the event)
                await conn.execute(
                    "UPDATE meeting_calendar_links SET sync_status='not_configured', last_error=$3, "
                    "updated_at=now() WHERE meeting_id=$1 AND provider=$2", meeting_id, provider_name, str(e))
                log.info("calendar not configured meeting=%s provider=%s", meeting_id, provider_name)
    else:
        # started / paused / resumed / cancelled and future events
        await _publish_realtime(event_type, payload)
        await _notify(event_type, payload)


async def process_once(pool) -> bool:
    """Claim and process a single due event. Returns True if one was handled."""
    async with pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        row = await conn.fetchrow(
            """
            SELECT id, event_type, aggregate_id, payload, attempt_count
            FROM meeting_outbox
            WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
            ORDER BY next_attempt_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """)
        if row is None:
            await tr.rollback()
            return False
        try:
            await _handle(conn, row)
            await conn.execute(
                "UPDATE meeting_outbox SET status='PROCESSED', processed_at=now(), "
                "attempt_count=attempt_count+1, last_error=NULL WHERE id=$1", row["id"])
            await tr.commit()
            log.info("processed event=%s id=%s", row["event_type"], row["id"])
            return True
        except Exception as e:                       # noqa: BLE001 — worker must never die on one bad row
            await tr.rollback()
            attempts = row["attempt_count"] + 1
            async with pool.acquire() as c2:
                if attempts >= _MAX_ATTEMPTS:
                    await c2.execute(
                        "UPDATE meeting_outbox SET status='FAILED', attempt_count=$2, last_error=$3, "
                        "next_attempt_at=now() + interval '100 years' WHERE id=$1",
                        row["id"], attempts, f"gave up after {attempts}: {e}"[:1000])
                    log.error("event id=%s FAILED permanently after %d attempts: %s", row["id"], attempts, e)
                else:
                    await c2.execute(
                        "UPDATE meeting_outbox SET status='FAILED', attempt_count=$2, last_error=$3, "
                        "next_attempt_at=now() + ($4 || ' seconds')::interval WHERE id=$1",
                        row["id"], attempts, str(e)[:1000], str(_backoff_seconds(attempts)))
                    log.warning("event id=%s attempt %d failed, retrying: %s", row["id"], attempts, e)
            return True


async def _reap_stuck(pool):
    """Reset rows left PROCESSING by a crashed worker back to PENDING."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE meeting_outbox SET status='PENDING' "
            "WHERE status='PROCESSING' AND created_at < now() - ($1 || ' minutes')::interval",
            str(_STUCK_PROCESSING_MINUTES))


async def run_forever():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    log.info("outbox worker started")
    try:
        await _reap_stuck(pool)
        while True:
            worked = await process_once(pool)
            if not worked:
                await asyncio.sleep(_POLL_IDLE_SECONDS)
    finally:
        await pool.close()


async def drain(limit: int = 1000) -> int:
    """Process all currently-due events and return the count (used by tests / one-shot runs)."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    n = 0
    try:
        await _reap_stuck(pool)
        while n < limit and await process_once(pool):
            n += 1
    finally:
        await pool.close()
    return n
