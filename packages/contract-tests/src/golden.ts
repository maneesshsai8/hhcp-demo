/**
 * The golden request set. Both backends share one DB, so read endpoints must
 * return identical bodies. Write/behavioral cases (§16.4) are gated behind
 * --behavioral and require seed fixtures (a meeting id / tenant id via env).
 */
export interface Case {
  name: string;
  as?: 'admin' | 'anon';
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 'body' (default) diffs status+body; 'status' diffs only the status code. */
  parity?: 'body' | 'status';
  /** For security assertions: the exact status BOTH backends must return. */
  expectStatus?: number;
  behavioral?: boolean;
}

const NIL = '00000000-0000-0000-0000-000000000000';

/** §16.1/§16 read-parity: every module's primary GET, diffed body-for-body. */
export const READ_CASES: Case[] = [
  { name: 'auth/me', path: '/auth/me' },
  { name: 'directory', path: '/directory' },
  { name: 'vision', path: '/vision' },
  { name: 'todos', path: '/todos' },
  { name: 'todos/stats', path: '/todos/stats' },
  { name: 'teams', path: '/teams' },
  { name: 'users', path: '/users' },
  { name: 'organizations', path: '/organizations' },
  { name: 'organizations/grants', path: '/organizations/grants' },
  { name: 'scorecards', path: '/scorecards' },
  { name: 'rocks', path: '/rocks' },
  { name: 'issues', path: '/issues' },
  { name: 'issues/stats', path: '/issues/stats' },
  { name: 'vcbs', path: '/vcbs' },
  { name: 'seats', path: '/seats' },
  { name: 'seats/versions', path: '/seats/versions' },
  { name: 'audit', path: '/audit' },
  { name: 'federation/rollup', path: '/federation/rollup' },
  { name: 'announcements', path: '/announcements' },
  { name: 'meetings', path: '/meetings' },
  { name: 'meetings/agendas', path: '/meetings/agendas' },
  { name: 'meetings/templates/list', path: '/meetings/templates/list' },
  { name: 'meetings/ratings/trend', path: '/meetings/ratings/trend' },
];

/** §16.3 security parity — proven, not asserted. */
export const SECURITY_CASES: Case[] = [
  {
    name: 'no-context → 401 (unauthenticated)',
    as: 'anon',
    path: '/todos',
    parity: 'status',
    expectStatus: 401,
  },
  {
    name: 'cross-tenant tenant_id in URL → empty list (RLS)',
    path: `/todos?tenant_id=${NIL}`,
    parity: 'body', // both must return [] for a tenant the caller can't see
  },
  {
    name: 'switch-tenant to a non-granted tenant → 403',
    method: 'POST',
    path: '/auth/switch-tenant',
    body: { tenant_id: NIL },
    parity: 'status',
    expectStatus: 403,
  },
];

/**
 * §16.4 behavioral parity. Data-dependent: supply FIXTURE_TENANT_ID (a tenant the
 * admin can create in) to exercise idempotency + optimistic-lock. Skipped when
 * the fixture env is absent.
 */
export function behavioralCases(): Case[] {
  const cases: Case[] = [];
  const tenant = process.env.FIXTURE_TENANT_ID;
  if (tenant) {
    // Idempotency: the same Idempotency-Key + same body must replay (not double-create).
    cases.push({
      name: 'meeting start idempotency replay (same key+body → identical response)',
      method: 'POST',
      path: '/meetings/start',
      headers: { 'Idempotency-Key': 'contract-test-fixed-key-1' },
      body: { tenant_id: tenant, template: 'level10', title: 'Contract Test Meeting' },
      behavioral: true,
    });
  }
  const meetingId = process.env.FIXTURE_MEETING_ID;
  if (meetingId) {
    // Optimistic lock: a stale expected_version must 409 on both backends.
    cases.push({
      name: 'meeting optimistic-lock stale version → 409',
      method: 'PATCH',
      path: `/meetings/${meetingId}`,
      body: { expected_version: 999999, title: 'x' },
      parity: 'status',
      expectStatus: 409,
      behavioral: true,
    });
  }
  return cases;
}
