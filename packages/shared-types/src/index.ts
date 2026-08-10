/**
 * Framework-agnostic types shared across the Node backend, the outbox worker,
 * and the frontend. Mirrors the source-of-truth values that live in the DB
 * (roles, RAG bands) and the Python app (outbox event types).
 */

/** The 11 roles in the RBAC action matrix (see permissions). */
export type Role =
  | 'fund_admin'
  | 'fund_viewer'
  | 'lead_partner'
  | 'deal_qb'
  | 'portco_management'
  | 'operating_partner'
  | 'board_member'
  | 'manager'
  | 'team_member'
  | 'viewer'
  | 'external';

export type Action = 'view' | 'create' | 'edit' | 'delete' | 'provision';

/** Weekly scorecard RAG status. */
export type Rag = 'green' | 'yellow' | 'red';

/** The 9 transactional-outbox event types dispatched by the worker (§2.5). */
export type OutboxEventType =
  | 'calendar.create'
  | 'meeting.started'
  | 'meeting.paused'
  | 'meeting.resumed'
  | 'meeting.cancelled'
  | 'meeting.completed'
  | 'segment.changed'
  | 'segment.updated'
  | 'agenda.reordered'
  | 'announcement.published'
  | 'announcement.updated';
