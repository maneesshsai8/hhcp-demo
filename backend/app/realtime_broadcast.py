"""
Server-authoritative Supabase Realtime Broadcast.

Confirmed (committed) meeting events are published to the private-ish channel
`meeting:<id>` by POSTing to Supabase Realtime's broadcast REST endpoint with the
service-role key. Clients NEVER broadcast authoritative state — they subscribe,
receive the lightweight event envelope, and refetch /live-state (the RLS-guarded
source of truth). This is called from the outbox worker, i.e. strictly AFTER the
domain transaction commits.

Delivery is best-effort by design: if Realtime is down the committed DB state is
untouched and clients still recover via REST. So broadcast() never raises.
"""
import logging

import httpx

from app import config

log = logging.getLogger("meetings.realtime")

# service-role preferred (bypasses Realtime authorization); anon also works on
# public channels in local dev. Either lets the server publish.
_KEY = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY


def channel_for(meeting_id: str) -> str:
    return f"meeting:{meeting_id}"


def tenant_announcements_channel(tenant_id: str) -> str:
    return f"tenant:{tenant_id}:announcements"


def team_announcements_channel(team_id: str) -> str:
    return f"team:{team_id}:announcements"


async def broadcast(meeting_id: str, event: str, payload: dict) -> bool:
    """Publish one event to a meeting's channel. Convenience wrapper around
    broadcast_to(). Returns True on 2xx, else False. Never raises."""
    return await broadcast_to(channel_for(meeting_id), event, payload)


async def broadcast_to(channel: str, event: str, payload: dict) -> bool:
    """Publish one event to an arbitrary Realtime channel. Returns True on 2xx,
    else False. Never raises — realtime is a best-effort transport, not a system
    of record (clients always recover via the RLS-guarded REST feed)."""
    if not (config.SUPABASE_URL and _KEY):
        log.debug("realtime not configured; skipping %s", event)
        return False
    url = f"{config.SUPABASE_URL}/realtime/v1/api/broadcast"
    body = {"messages": [{"topic": channel, "event": event, "payload": payload}]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(url, json=body,
                                  headers={"apikey": _KEY, "Authorization": f"Bearer {_KEY}",
                                           "Content-Type": "application/json"})
        if r.status_code // 100 == 2:
            return True
        log.warning("realtime broadcast %s -> HTTP %s", event, r.status_code)
        return False
    except Exception as e:                       # noqa: BLE001 — best-effort transport
        log.warning("realtime broadcast %s failed: %s", event, e)
        return False
