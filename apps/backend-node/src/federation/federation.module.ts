import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { performance } from 'perf_hooks';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { DatabaseService } from '../database/database.service';

/**
 * Data Federation POC — Approach 1: QUERY-TIME FAN-OUT.
 *
 * Faithful port of backend/app/routers/federation.py. At read time it scans
 * every tenant the caller can see (RLS already scopes that to their accessible
 * subtree — no tenant filter is written here) with a handful of GROUP BY
 * queries, then rolls the per-tenant numbers up the Fund → PortCo → Add-on
 * hierarchy in the app. Returns `fanout_ms` + `tenants_scanned` so the "does it
 * scale?" question gets a real, observable answer as the portfolio grows.
 */

type Metrics = Record<string, Record<string, number>>;

function empty(): Metrics {
  return {
    rocks: { on_track: 0, off_track: 0, complete: 0, total: 0 },
    issues: { open: 0, solved: 0 },
    todos: { total: 0, done: 0, overdue: 0 },
    kpis: { count: 0 },
    vcbs: { count: 0, rock_done: 0, rock_total: 0 },
  };
}

/** Sum two metric dicts (used to roll descendants into ancestors). */
function add(a: Metrics, b: Metrics): Metrics {
  const out = empty();
  for (const grp of Object.keys(out)) {
    for (const k of Object.keys(out[grp])) {
      out[grp][k] = a[grp][k] + b[grp][k];
    }
  }
  return out;
}

function pct(done: number, tot: number): number {
  return tot ? Math.round((done / tot) * 100) : 0;
}

@Controller('federation')
@UseGuards(AuthGuard)
export class FederationController {
  constructor(private readonly db: DatabaseService) {}

  @Get('rollup')
  async rollup(@Auth() user: CurrentUser) {
    const t0 = performance.now();
    const scans = await this.db.scoped(user.user_id, async (sql) => {
      // The tenants this caller can see (RLS-scoped) — the fan-out set.
      const orgs = await sql`
        SELECT id, name, tenant_type, parent_tenant_id FROM organizations ORDER BY name
      `;
      // One GROUP BY per module = the 'fan-out'. RLS restricts every scan to the
      // accessible subtree automatically, so no tenant filter is written here.
      const rocks = await sql`
        SELECT tenant_id,
               count(*) AS total,
               count(*) FILTER (WHERE status='on_track') AS on_track,
               count(*) FILTER (WHERE status='off_track') AS off_track,
               count(*) FILTER (WHERE status='complete') AS complete
        FROM rocks GROUP BY tenant_id`;
      const issues = await sql`
        SELECT tenant_id,
               count(*) FILTER (WHERE status='open') AS open,
               count(*) FILTER (WHERE status='solved') AS solved
        FROM issues GROUP BY tenant_id`;
      const todos = await sql`
        SELECT tenant_id,
               count(*) AS total,
               count(*) FILTER (WHERE status='done') AS done,
               count(*) FILTER (WHERE status='open' AND due_date < CURRENT_DATE) AS overdue
        FROM todos GROUP BY tenant_id`;
      const kpis = await sql`SELECT tenant_id, count(*) AS count FROM kpis GROUP BY tenant_id`;
      const vcbs = await sql`SELECT tenant_id, count(*) AS count FROM vcbs GROUP BY tenant_id`;
      const vcbRocks = await sql`
        SELECT r.tenant_id,
               count(*) AS total,
               count(*) FILTER (WHERE r.status='complete') AS done
        FROM rocks r JOIN workstreams w ON w.id = r.workstream_id
        GROUP BY r.tenant_id`;
      return { orgs, rocks, issues, todos, kpis, vcbs, vcbRocks };
    });

    const { orgs, rocks, issues, todos, kpis, vcbs, vcbRocks } = scans;

    // index the raw scans by tenant
    const per: Record<string, Metrics> = {};
    for (const o of orgs) per[String(o.id)] = empty();
    for (const r of rocks) {
      const m = per[String(r.tenant_id)];
      if (m) m.rocks = { on_track: r.on_track, off_track: r.off_track, complete: r.complete, total: r.total };
    }
    for (const r of issues) {
      const m = per[String(r.tenant_id)];
      if (m) m.issues = { open: r.open, solved: r.solved };
    }
    for (const r of todos) {
      const m = per[String(r.tenant_id)];
      if (m) m.todos = { total: r.total, done: r.done, overdue: r.overdue };
    }
    for (const r of kpis) {
      const m = per[String(r.tenant_id)];
      if (m) m.kpis.count = r.count;
    }
    for (const r of vcbs) {
      const m = per[String(r.tenant_id)];
      if (m) m.vcbs.count = r.count;
    }
    for (const r of vcbRocks) {
      const m = per[String(r.tenant_id)];
      if (m) {
        m.vcbs.rock_done = r.done;
        m.vcbs.rock_total = r.total;
      }
    }

    // children map for the hierarchy roll-up
    const visibleIds = new Set(orgs.map((o) => String(o.id)));
    const children: Record<string, string[]> = {};
    for (const o of orgs) {
      const parent = o.parent_tenant_id ? String(o.parent_tenant_id) : 'null';
      (children[parent] ||= []).push(String(o.id));
    }

    // A "root" of the VISIBLE subtree = a tenant whose parent is null OR whose
    // parent is outside what this caller can see (e.g. a PortCo user whose parent
    // is the Fund they can't access). Without this, a non-admin's rollup summed
    // over an empty root set and showed all zeros.
    const isRoot = (o: Record<string, unknown>): boolean => {
      const p = o.parent_tenant_id ? String(o.parent_tenant_id) : null;
      return p === null || !visibleIds.has(p);
    };
    const rootIds = orgs.filter(isRoot).map((o) => String(o.id));

    const rolled = (tid: string): Metrics => {
      let total = per[tid];
      for (const c of children[tid] ?? []) total = add(total, rolled(c));
      return total;
    };

    const rows = orgs.map((o) => {
      const tid = String(o.id);
      const rollM = rolled(tid);
      return {
        tenant_id: tid,
        name: o.name,
        tenant_type: o.tenant_type,
        parent_tenant_id: o.parent_tenant_id ? String(o.parent_tenant_id) : null,
        self: per[tid],
        rollup: rollM, // self + all descendants
        rock_completion_pct: pct(rollM.rocks.complete, rollM.rocks.total),
        vcb_progress_pct: pct(rollM.vcbs.rock_done, rollM.vcbs.rock_total),
      };
    });

    // fund-level total = sum of the visible roots' rollups (disjoint subtrees)
    let fundTotal = empty();
    for (const rid of rootIds) fundTotal = add(fundTotal, rolled(rid));

    const fanoutMs = Math.round((performance.now() - t0) * 10) / 10;
    return {
      approach: 'query-time-fanout',
      tenants_scanned: orgs.length,
      fanout_ms: fanoutMs,
      queries_run: 6,
      tenants: rows,
      fund_total: fundTotal,
      fund_rock_completion_pct: pct(fundTotal.rocks.complete, fundTotal.rocks.total),
    };
  }
}

@Module({ controllers: [FederationController] })
export class FederationModule {}
