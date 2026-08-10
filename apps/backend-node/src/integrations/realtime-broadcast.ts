/**
 * Server-authoritative Supabase Realtime Broadcast. Faithful port of
 * backend/app/realtime_broadcast.py.
 *
 * Confirmed (committed) events are published to a channel by POSTing to
 * Supabase Realtime's broadcast REST endpoint with the service-role key. Clients
 * NEVER broadcast authoritative state — they subscribe, receive the lightweight
 * envelope, and refetch the RLS-guarded source of truth. Called from the outbox
 * worker, strictly AFTER the domain transaction commits.
 *
 * Delivery is best-effort: broadcast never throws. Reads SUPABASE_* from
 * process.env at call time, so it works in both the Nest app and the worker.
 */
function key(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || undefined;
}

export function channelFor(meetingId: string): string {
  return `meeting:${meetingId}`;
}
export function tenantAnnouncementsChannel(tenantId: string): string {
  return `tenant:${tenantId}:announcements`;
}
export function teamAnnouncementsChannel(teamId: string): string {
  return `team:${teamId}:announcements`;
}

/** Publish one event to an arbitrary Realtime channel. True on 2xx, else false. Never throws. */
export async function broadcastTo(
  channel: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const k = key();
  if (!url || !k) return false;
  const body = { messages: [{ topic: channel, event, payload }] };
  try {
    const r = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return Math.floor(r.status / 100) === 2;
  } catch {
    return false;
  }
}

/** Publish one event to a meeting's channel. Convenience wrapper. */
export async function broadcast(
  meetingId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  return broadcastTo(channelFor(meetingId), event, payload);
}
