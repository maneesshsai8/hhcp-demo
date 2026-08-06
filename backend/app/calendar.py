"""
Calendar provider abstraction.

A single Protocol with Google and Microsoft adapters. The adapters are
SCAFFOLDING: the request-shaping and boundary are real, but the actual HTTP
calls are gated behind `is_configured()` and raise CalendarNotConfigured until
OAuth credentials exist in the environment. This lets the async sync pipeline
(outbox -> worker -> provider -> meeting_calendar_links) be built and exercised
end-to-end now, and turned live later by only filling in `_create_event` and the
env vars — no call-site changes.

Provider tokens live only in the backend env; they are never returned to clients.
"""
from typing import Protocol

from app import config


class CalendarNotConfigured(Exception):
    """Raised when a provider is selected but its OAuth credentials are absent."""


class CalendarEventResult(dict):
    """{'external_event_id':..., 'external_calendar_id':...}"""


class CalendarProvider(Protocol):
    name: str
    async def create_event(self, *, title: str, description: str | None,
                           start, end, attendees: list[str]) -> CalendarEventResult: ...
    async def update_event(self, external_event_id: str, **fields) -> CalendarEventResult: ...
    async def cancel_event(self, external_event_id: str) -> None: ...


class _BaseProvider:
    name = "base"
    def is_configured(self) -> bool:                       # pragma: no cover - trivial
        return False
    async def create_event(self, *, title, description, start, end, attendees):
        if not self.is_configured():
            raise CalendarNotConfigured(f"{self.name} calendar is not configured")
        return await self._create_event(title, description, start, end, attendees)
    async def update_event(self, external_event_id, **fields):
        if not self.is_configured():
            raise CalendarNotConfigured(f"{self.name} calendar is not configured")
        return await self._update_event(external_event_id, **fields)
    async def cancel_event(self, external_event_id):
        if not self.is_configured():
            raise CalendarNotConfigured(f"{self.name} calendar is not configured")
        await self._cancel_event(external_event_id)
    # ---- to implement when going live (real HTTP + OAuth token refresh) ----
    async def _create_event(self, title, description, start, end, attendees):  # pragma: no cover
        raise NotImplementedError
    async def _update_event(self, external_event_id, **fields):                # pragma: no cover
        raise NotImplementedError
    async def _cancel_event(self, external_event_id):                          # pragma: no cover
        raise NotImplementedError


class GoogleCalendarProvider(_BaseProvider):
    name = "google"
    def is_configured(self) -> bool:
        return bool(getattr(config, "GOOGLE_CALENDAR_CLIENT_ID", None)
                    and getattr(config, "GOOGLE_CALENDAR_REFRESH_TOKEN", None))
    # _create_event etc. would POST to https://www.googleapis.com/calendar/v3/... here.


class MicrosoftOutlookProvider(_BaseProvider):
    name = "microsoft"
    def is_configured(self) -> bool:
        return bool(getattr(config, "MS_CALENDAR_CLIENT_ID", None)
                    and getattr(config, "MS_CALENDAR_REFRESH_TOKEN", None))
    # _create_event etc. would POST to https://graph.microsoft.com/v1.0/me/events here.


_PROVIDERS = {p.name: p for p in (GoogleCalendarProvider(), MicrosoftOutlookProvider())}


def get_provider(name: str | None) -> _BaseProvider | None:
    return _PROVIDERS.get((name or "").lower())
