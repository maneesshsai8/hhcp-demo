/**
 * Calendar provider abstraction. Faithful port of backend/app/calendar.py.
 *
 * Google and Microsoft adapters are SCAFFOLDING: the request-shaping and
 * boundary are real, but the actual HTTP calls are gated behind isConfigured()
 * and throw CalendarNotConfigured until OAuth creds exist. This lets the async
 * sync pipeline (outbox → worker → provider → meeting_calendar_links) be
 * exercised end-to-end now and turned live later by only filling in _createEvent
 * and the env vars. Reads *_CALENDAR_* from process.env at call time so it works
 * in both the Nest app and the worker. Provider tokens never reach clients.
 */
export class CalendarNotConfigured extends Error {}

export interface CalendarEventResult {
  external_event_id?: string;
  external_calendar_id?: string;
}

export interface CreateEventArgs {
  title?: string | null;
  description?: string | null;
  start?: string | null;
  end?: string | null;
  attendees?: string[];
}

abstract class BaseProvider {
  abstract readonly name: string;
  isConfigured(): boolean {
    return false;
  }
  async createEvent(args: CreateEventArgs): Promise<CalendarEventResult> {
    if (!this.isConfigured()) throw new CalendarNotConfigured(`${this.name} calendar is not configured`);
    return this._createEvent(args);
  }
  async updateEvent(externalEventId: string, fields: Record<string, unknown>): Promise<CalendarEventResult> {
    if (!this.isConfigured()) throw new CalendarNotConfigured(`${this.name} calendar is not configured`);
    return this._updateEvent(externalEventId, fields);
  }
  async cancelEvent(externalEventId: string): Promise<void> {
    if (!this.isConfigured()) throw new CalendarNotConfigured(`${this.name} calendar is not configured`);
    await this._cancelEvent(externalEventId);
  }
  // ---- to implement when going live (real HTTP + OAuth token refresh) ----
  protected async _createEvent(_args: CreateEventArgs): Promise<CalendarEventResult> {
    throw new Error('not implemented');
  }
  protected async _updateEvent(_id: string, _fields: Record<string, unknown>): Promise<CalendarEventResult> {
    throw new Error('not implemented');
  }
  protected async _cancelEvent(_id: string): Promise<void> {
    throw new Error('not implemented');
  }
}

class GoogleCalendarProvider extends BaseProvider {
  readonly name = 'google';
  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_REFRESH_TOKEN);
  }
  // _createEvent would POST to https://www.googleapis.com/calendar/v3/... here.
}

class MicrosoftOutlookProvider extends BaseProvider {
  readonly name = 'microsoft';
  isConfigured(): boolean {
    return Boolean(process.env.MS_CALENDAR_CLIENT_ID && process.env.MS_CALENDAR_REFRESH_TOKEN);
  }
  // _createEvent would POST to https://graph.microsoft.com/v1.0/me/events here.
}

const PROVIDERS: Record<string, BaseProvider> = {
  google: new GoogleCalendarProvider(),
  microsoft: new MicrosoftOutlookProvider(),
};

export function getProvider(name: string | null | undefined): BaseProvider | null {
  return PROVIDERS[(name || '').toLowerCase()] ?? null;
}
