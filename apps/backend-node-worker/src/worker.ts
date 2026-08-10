/**
 * Outbox worker — the durable, out-of-request half of the meetings + announcements
 * backbone. Faithful port of backend/app/workers/outbox_worker.py.
 *
 * A SEPARATE process from the API. Drains meeting_outbox with FOR UPDATE SKIP
 * LOCKED so many workers can run without double-processing, regenerates the
 * post-meeting summary for meeting.completed, fans out announcements, syncs
 * calendar events, and publishes confirmed events to Supabase Realtime. The
 * worker has no user context, so for events that read tenant data it sets
 * app.current_user_id to the event's actorId (who by construction can see that
 * tenant) — no superuser/RLS bypass.
 */
import type { Sql, TransactionSql } from 'postgres';
import { buildSummary } from '../../backend-node/src/common/meeting-summary';
import { sendEmail } from '../../backend-node/src/common/mailer';
import {
  broadcast,
  broadcastTo,
  tenantAnnouncementsChannel,
  teamAnnouncementsChannel,
} from '../../backend-node/src/integrations/realtime-broadcast';
import { getProvider, CalendarNotConfigured } from '../../backend-node/src/integrations/calendar';

const MAX_ATTEMPTS = 8;
const POLL_IDLE_MS = 500; // snappy live-meeting propagation
const STUCK_PROCESSING_MINUTES = 5;

/* eslint-disable no-console */
const log = {
  info: (...a: unknown[]) => console.log(new Date().toISOString(), 'INFO', ...a),
  warn: (...a: unknown[]) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a: unknown[]) => console.error(new Date().toISOString(), 'ERROR', ...a),
};
/* eslint-enable no-console */

function backoffSeconds(attempt: number): number {
  return Math.min(300, 2 ** attempt); // 2,4,8,... capped at 5 min
}

type Row = Record<string, any>;

async function publishRealtime(eventType: string, payload: Row): Promise<void> {
  const meetingId = payload.meetingId;
  if (!meetingId) return;
  const ok = await broadcast(String(meetingId), eventType, payload);
  log.info(`realtime.publish ${eventType} meeting=${meetingId} ok=${ok}`);
}

function notify(eventType: string, payload: Row): void {
  log.info(`notify ${eventType} meeting=${payload.meetingId}`);
}

async function broadcastAnnouncement(ann: Row, eventType: string): Promise<void> {
  const envelope = { announcementId: String(ann.id), tenantId: String(ann.tenant_id) };
  const channel =
    ann.audience === 'team' && ann.team_id
      ? teamAnnouncementsChannel(String(ann.team_id))
      : tenantAnnouncementsChannel(String(ann.tenant_id));
  const ok = await broadcastTo(channel, eventType, envelope);
  log.info(`realtime.publish ${eventType} channel=${channel} ok=${ok}`);
}

async function handleAnnouncement(tx: TransactionSql, eventType: string, payload: Row): Promise<void> {
  const annId = payload.announcementId || String(payload.aggregate_id);
  const actorId = payload.actorId;
  if (actorId) {
    await tx`SELECT set_config('app.current_user_id', ${String(actorId)}, true)`;
  }

  const annRows = await tx`
    SELECT id, tenant_id, title, body, audience, team_id, requires_ack
    FROM announcements WHERE id = ${annId} AND status = 'published'
  `;
  const ann = annRows[0];
  if (!ann) {
    log.info(`announcement ${annId} not published/visible; skipping`);
    return;
  }
  const tenantId = String(ann.tenant_id);

  // An update only nudges open feeds to refetch — no re-fan-out.
  if (eventType === 'announcement.updated') {
    await broadcastAnnouncement(ann, eventType);
    return;
  }

  // 1. Snapshot the audience.
  if (ann.audience === 'team' && ann.team_id) {
    await tx`
      INSERT INTO announcement_recipients (announcement_id, user_id, tenant_id)
      SELECT ${annId}, tm.user_id, ${tenantId} FROM team_members tm WHERE tm.team_id = ${ann.team_id}
      ON CONFLICT (announcement_id, user_id) DO NOTHING`;
  } else {
    await tx`
      INSERT INTO announcement_recipients (announcement_id, user_id, tenant_id)
      SELECT ${annId}, m.user_id, ${tenantId} FROM tenant_memberships m WHERE m.tenant_id = ${tenantId}
      ON CONFLICT (announcement_id, user_id) DO NOTHING`;
  }

  // 2. In-app delivery: idempotent via NOT EXISTS (partitioned table, no cross-partition unique).
  await tx`
    INSERT INTO notification_deliveries (announcement_id, tenant_id, user_id, channel, status, sent_at)
    SELECT ${annId}, ${tenantId}, r.user_id, 'in_app', 'sent', now()
    FROM announcement_recipients r
    WHERE r.announcement_id = ${annId}
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries d
                      WHERE d.announcement_id = ${annId} AND d.user_id = r.user_id AND d.channel = 'in_app')`;

  // 3. Email delivery: queue rows, send, flip to sent/failed.
  const emailRows = await tx`
    INSERT INTO notification_deliveries (announcement_id, tenant_id, user_id, channel, status)
    SELECT ${annId}, ${tenantId}, r.user_id, 'email', 'queued'
    FROM announcement_recipients r
    JOIN users u ON u.id = r.user_id
    WHERE r.announcement_id = ${annId} AND u.email IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries d
                      WHERE d.announcement_id = ${annId} AND d.user_id = r.user_id AND d.channel = 'email')
    RETURNING id, user_id`;
  if (emailRows.length) {
    const userIds = emailRows.map((r) => r.user_id);
    const emails = await tx`SELECT id, email FROM users WHERE id = ANY(${userIds}::uuid[])`;
    const addrs = emails.map((e) => e.email as string).filter(Boolean);
    const origin = process.env.LUCID_EMBED_ORIGIN ?? 'http://localhost:3002';
    const sent = addrs.length
      ? await sendEmail(
          addrs,
          `[Announcement] ${ann.title}`,
          `${ann.body || ''}\n\n` +
            (ann.requires_ack ? 'This announcement requires your acknowledgment. ' : '') +
            `Open the portal to view it: ${origin}/dashboard/announcements`,
        )
      : false;
    const newStatus = sent ? 'sent' : 'failed';
    await tx`
      UPDATE notification_deliveries SET status = ${newStatus}, sent_at = now(),
        error = CASE WHEN ${newStatus} = 'failed' THEN 'smtp send failed' ELSE NULL END
      WHERE announcement_id = ${annId} AND channel = 'email' AND status = 'queued'`;
    log.info(`announcement ${annId} emailed ${addrs.length} recipient(s) ok=${sent}`);
  }

  // 4. Nudge live feeds (best-effort).
  await broadcastAnnouncement(ann, eventType);
}

async function handle(tx: TransactionSql, row: Row): Promise<void> {
  const eventType: string = row.event_type;
  const payload: Row =
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
  const meetingId = payload.meetingId || String(row.aggregate_id);

  if (eventType.startsWith('announcement.')) {
    await handleAnnouncement(tx, eventType, payload);
    return;
  }

  if (eventType === 'meeting.completed') {
    const actorId = payload.actorId;
    if (actorId) {
      await tx`SELECT set_config('app.current_user_id', ${String(actorId)}, true)`;
      const summary = await buildSummary(tx, meetingId);
      await tx`UPDATE meetings SET summary = ${tx.json(summary as never)}::jsonb WHERE id = ${meetingId}`;
      log.info(
        `summary regenerated meeting=${meetingId} rating=${summary.rating} todos=${summary.todos_created.length}`,
      );
    }
    await publishRealtime('summary.generated', payload);
    notify('meeting.completed', payload);
  } else if (eventType === 'calendar.create') {
    const actorId = payload.actorId;
    const providerName = payload.provider;
    if (actorId) {
      await tx`SELECT set_config('app.current_user_id', ${String(actorId)}, true)`;
    }
    const prov = getProvider(providerName);
    if (prov === null) {
      await tx`
        UPDATE meeting_calendar_links SET sync_status = 'failed', last_error = 'unknown provider',
          updated_at = now() WHERE meeting_id = ${meetingId} AND provider = ${providerName}`;
    } else {
      try {
        const res = await prov.createEvent({
          title: payload.title,
          description: null,
          start: payload.scheduledAt,
          end: null,
          attendees: [],
        });
        await tx`
          UPDATE meeting_calendar_links SET sync_status = 'synced', external_event_id = ${res.external_event_id ?? null},
            last_synced_at = now(), last_error = NULL, updated_at = now()
          WHERE meeting_id = ${meetingId} AND provider = ${providerName}`;
        log.info(`calendar synced meeting=${meetingId} provider=${providerName}`);
      } catch (e) {
        if (e instanceof CalendarNotConfigured) {
          // expected in the demo: record and move on (do NOT fail/retry)
          await tx`
            UPDATE meeting_calendar_links SET sync_status = 'not_configured', last_error = ${String(e.message)},
              updated_at = now() WHERE meeting_id = ${meetingId} AND provider = ${providerName}`;
          log.info(`calendar not configured meeting=${meetingId} provider=${providerName}`);
        } else {
          throw e;
        }
      }
    }
  } else {
    // started / paused / resumed / cancelled / segment.* / agenda.reordered
    await publishRealtime(eventType, payload);
    notify(eventType, payload);
  }
}

/** Claim and process a single due event. Returns true if one was handled. */
export async function processOnce(sql: Sql): Promise<boolean> {
  let claimed: Row | null = null;
  try {
    const result = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, event_type, aggregate_id, payload, attempt_count
        FROM meeting_outbox
        WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`;
      const row = rows[0];
      if (!row) return { none: true } as const;
      claimed = row;
      await handle(tx, row);
      await tx`
        UPDATE meeting_outbox SET status = 'PROCESSED', processed_at = now(),
          attempt_count = attempt_count + 1, last_error = NULL WHERE id = ${row.id}`;
      return { row } as const;
    });
    if ('none' in result) return false;
    log.info(`processed event=${result.row.event_type} id=${result.row.id}`);
    return true;
  } catch (e) {
    if (!claimed) {
      // no row claimed (e.g. transient select error) — nothing to record
      log.warn(`process_once error before claim: ${e}`);
      return false;
    }
    const row: Row = claimed;
    const attempts = row.attempt_count + 1;
    const errText = String((e as Error)?.message ?? e).slice(0, 1000);
    if (attempts >= MAX_ATTEMPTS) {
      await sql`
        UPDATE meeting_outbox SET status = 'FAILED', attempt_count = ${attempts},
          last_error = ${`gave up after ${attempts}: ${errText}`.slice(0, 1000)},
          next_attempt_at = now() + interval '100 years' WHERE id = ${row.id}`;
      log.error(`event id=${row.id} FAILED permanently after ${attempts} attempts: ${errText}`);
    } else {
      await sql`
        UPDATE meeting_outbox SET status = 'FAILED', attempt_count = ${attempts}, last_error = ${errText},
          next_attempt_at = now() + (${String(backoffSeconds(attempts))} || ' seconds')::interval
        WHERE id = ${row.id}`;
      log.warn(`event id=${row.id} attempt ${attempts} failed, retrying: ${errText}`);
    }
    return true;
  }
}

async function reapStuck(sql: Sql): Promise<void> {
  await sql`
    UPDATE meeting_outbox SET status = 'PENDING'
    WHERE status = 'PROCESSING' AND created_at < now() - (${String(STUCK_PROCESSING_MINUTES)} || ' minutes')::interval`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runForever(sql: Sql): Promise<void> {
  log.info('outbox worker started');
  await reapStuck(sql);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const worked = await processOnce(sql);
    if (!worked) await sleep(POLL_IDLE_MS);
  }
}

/** Process all currently-due events and return the count (tests / one-shot runs). */
export async function drain(sql: Sql, limit = 1000): Promise<number> {
  let n = 0;
  await reapStuck(sql);
  while (n < limit && (await processOnce(sql))) n += 1;
  return n;
}
