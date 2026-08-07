"""
Server-authoritative Supabase Realtime Broadcast.

Confirmed (committed) events are published to PRIVATE, tenant-namespaced channels
(`tenant:<tenant_id>:…`) via Supabase Realtime's broadcast REST endpoint using the
service-role key (which bypasses Realtime RLS, so the server can always publish).
Subscribers only receive if their minted Realtime token's `app_tenants` claim
covers the channel's tenant — see database/realtime_authorization.sql. Clients
NEVER broadcast authoritative state; they receive a lightweight envelope and
refetch the RLS-guarded REST feed. Published from the outbox worker / after commit.

Delivery is best-effort: if Realtime is down the committed DB state is untouched
and clients recover via REST. So nothing here ever raises.
"""
import logging

import httpx

from app import config

log = logging.getLogger("meetings.realtime")

# service-role preferred (bypasses Realtime authorization); anon also works on
# public channels in local dev. Either lets the server publish.
_KEY = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY


# Every channel is namespaced `tenant:<tenant_id>:…` so the Realtime RLS policy
# can parse the tenant (split_part(topic,':',2)) and match it to the token claim.
def channel_for(tenant_id: str, meeting_id: str) -> str:
    return f"tenant:{tenant_id}:meeting:{meeting_id}"


def tenant_announcements_channel(tenant_id: str) -> str:
    return f"tenant:{tenant_id}:announcements"


def team_announcements_channel(tenant_id: str, team_id: str) -> str:
    return f"tenant:{tenant_id}:team:{team_id}:announcements"


async def broadcast(tenant_id: str, meeting_id: str, event: str, payload: dict) -> bool:
    """Publish one event to a meeting's tenant-scoped private channel."""
    return await broadcast_to(channel_for(tenant_id, meeting_id), event, payload)


async def broadcast_to(channel: str, event: str, payload: dict) -> bool:
    """Publish one event to an arbitrary Realtime channel. Returns True on 2xx,
    else False. Never raises — realtime is a best-effort transport, not a system
    of record (clients always recover via the RLS-guarded REST feed)."""
    if not (config.SUPABASE_URL and _KEY):
        log.debug("realtime not configured; skipping %s", event)
        return False
    url = f"{config.SUPABASE_URL}/realtime/v1/api/broadcast"
    # private:true routes to the RLS-guarded private channel
    body = {"messages": [{"topic": channel, "event": event, "payload": payload, "private": True}]}
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
