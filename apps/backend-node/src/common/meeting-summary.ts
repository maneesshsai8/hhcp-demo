import type { ScopedSql } from '../database/database.service';

/**
 * Deterministic post-meeting summary builder. Faithful port of
 * backend/app/meeting_summary.py. Pure structured-data formatter (no AI).
 * Shared by the synchronous finish path and the background worker, so both
 * produce identical output. `sql` must already be RLS-scoped to a user who can
 * see the meeting's tenant (the request user, or the meeting's creator).
 */
function fmtDuration(seconds: number | null): string {
  if (!seconds) return '0 minutes';
  const m = Math.floor(seconds / 60);
  return `${m} minute${m !== 1 ? 's' : ''}`;
}

export interface MeetingSummary {
  title: string | null;
  meeting_type: string | null;
  date: string | null;
  duration_seconds: number;
  facilitator: string | null;
  attendance: number;
  present: string[];
  segments_total: number;
  scorecards_reviewed: number;
  rocks_reviewed: number;
  issues_raised: string[];
  issues_solved: number;
  todos_created: string[];
  rating: number | null;
  notes: string | null;
  summary_text: string;
}

export async function buildSummary(sql: ScopedSql, meetingId: string): Promise<MeetingSummary> {
  const mRows = await sql`
    SELECT m.title, m.tenant_id, m.started_at, m.ended_at, m.rating, m.notes,
           m.sections, m.meeting_type, u.name AS facilitator
    FROM meetings m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.id = ${meetingId}
  `;
  const m = mRows[0];
  if (!m) throw new Error('meeting not found or not accessible');

  const tenantId = m.tenant_id as string;
  const started = m.started_at as Date | null;
  // postgres.js parses jsonb to JS values automatically.
  const sections: Array<{ kind?: string }> = Array.isArray(m.sections)
    ? m.sections
    : m.sections
      ? JSON.parse(m.sections as string)
      : [];
  const kinds = sections.map((s) => s.kind);

  const presentRows = await sql`
    SELECT u.name FROM meeting_attendance a JOIN users u ON u.id = a.user_id
    WHERE a.meeting_id = ${meetingId} AND a.present ORDER BY u.name
  `;
  const present = presentRows.map((r) => r.name as string);

  let issuesRaised: string[] = [];
  let todosCreated: string[] = [];
  let issuesSolved = 0;
  if (started) {
    const ir = await sql`
      SELECT title FROM issues WHERE tenant_id = ${tenantId} AND created_at >= ${started} ORDER BY created_at
    `;
    issuesRaised = ir.map((r) => r.title as string);
    const isv = await sql`
      SELECT count(*) AS c FROM issues WHERE tenant_id = ${tenantId} AND solved_at >= ${started}
    `;
    issuesSolved = (isv[0]?.c as number) || 0;
    const tc = await sql`
      SELECT title FROM todos WHERE tenant_id = ${tenantId} AND created_at >= ${started} ORDER BY created_at
    `;
    todosCreated = tc.map((r) => r.title as string);
  }

  const ended = m.ended_at as Date | null;
  const duration = started && ended ? Math.floor((ended.getTime() - started.getTime()) / 1000) : 0;
  const rating = m.rating != null ? Number(m.rating) : null;

  const structured: MeetingSummary = {
    title: m.title as string | null,
    meeting_type: m.meeting_type as string | null,
    date: ended ? ended.toISOString() : null,
    duration_seconds: duration,
    facilitator: m.facilitator as string | null,
    attendance: present.length,
    present,
    segments_total: sections.length,
    scorecards_reviewed: kinds.filter((k) => k === 'scorecard').length,
    rocks_reviewed: kinds.filter((k) => k === 'rocks').length + kinds.filter((k) => k === 'vcbs').length,
    issues_raised: issuesRaised,
    issues_solved: issuesSolved,
    todos_created: todosCreated,
    rating,
    notes: m.notes as string | null,
    summary_text: '',
  };
  structured.summary_text = renderText(structured);
  return structured;
}

function renderText(s: MeetingSummary): string {
  const date = (s.date || '').slice(0, 10);
  const lines = [
    `${s.title} completed${date ? ` on ${date}` : ''}.`,
    '',
    `Attendees: ${s.attendance}`,
    `Duration: ${fmtDuration(s.duration_seconds)}`,
    `Segments: ${s.segments_total}`,
  ];
  if (s.scorecards_reviewed) lines.push(`Scorecard segments reviewed: ${s.scorecards_reviewed}`);
  if (s.rocks_reviewed) lines.push(`Rock/VCB segments reviewed: ${s.rocks_reviewed}`);
  lines.push(
    `Issues created: ${s.issues_raised.length}`,
    `Issues resolved: ${s.issues_solved}`,
    `To-Dos created: ${s.todos_created.length}`,
    `Average rating: ${s.rating != null ? s.rating : '—'}`,
  );
  return lines.join('\n');
}
