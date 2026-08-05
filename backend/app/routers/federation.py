"""
Data Federation POC — Approach 1: QUERY-TIME FAN-OUT.

The Phase 2 question is: how do we aggregate data up the Fund → PortCo → Add-on
hierarchy for portfolio reporting? This endpoint prototypes the recommended
first approach: at read time, scan every tenant the caller can see (RLS already
scopes that to their accessible subtree) with a handful of GROUP BY queries, then
roll the per-tenant numbers up the hierarchy in the app.

  - No extra infrastructure, always fresh.
  - We measure and return `fanout_ms` + `tenants_scanned` so the "does it scale?"
    question gets a real, observable answer as the portfolio grows.

For comparison, the OTHER two approaches are already partly seeded in this codebase:
  - Event-driven: audit_log already records scorecard.entry / rock.status /
    vcb.status events from day one — a reporting consumer could fold those into
    running aggregates instead of re-scanning.
  - Materialized view: this same aggregation could be written to a table by a
    nightly job; reads would then be a single indexed lookup (but stale between runs).
"""
import time

from fastapi import APIRouter, Depends
from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/federation", tags=["federation"])


def _empty():
    return {
        "rocks": {"on_track": 0, "off_track": 0, "complete": 0, "total": 0},
        "issues": {"open": 0, "solved": 0},
        "todos": {"total": 0, "done": 0, "overdue": 0},
        "kpis": {"count": 0},
        "vcbs": {"count": 0, "rock_done": 0, "rock_total": 0},
    }


def _add(a, b):
    """Sum two metric dicts (used to roll descendants into ancestors)."""
    out = _empty()
    for grp in out:
        for k in out[grp]:
            out[grp][k] = a[grp][k] + b[grp][k]
    return out


@router.get("/rollup")
async def rollup(current_user: CurrentUser = Depends(get_current_user)):
    """Query-time federated rollup across every accessible tenant.

    Returns each tenant's own numbers AND its hierarchy roll-up (self + all
    descendants), so a Fund row shows the whole portfolio and a PortCo row shows
    itself plus its add-on acquisitions."""
    t0 = time.perf_counter()
    async with get_scoped_connection(current_user.user_id) as conn:
        # The tenants this caller can see (RLS-scoped) — the fan-out set.
        orgs = await conn.fetch(
            "SELECT id, name, tenant_type, parent_tenant_id FROM organizations ORDER BY name"
        )
        # One GROUP BY per module = the 'fan-out'. RLS restricts every scan to the
        # accessible subtree automatically, so no tenant filter is written here.
        rocks = await conn.fetch(
            """SELECT tenant_id,
                      count(*) AS total,
                      count(*) FILTER (WHERE status='on_track') AS on_track,
                      count(*) FILTER (WHERE status='off_track') AS off_track,
                      count(*) FILTER (WHERE status='complete') AS complete
               FROM rocks GROUP BY tenant_id"""
        )
        issues = await conn.fetch(
            """SELECT tenant_id,
                      count(*) FILTER (WHERE status='open') AS open,
                      count(*) FILTER (WHERE status='solved') AS solved
               FROM issues GROUP BY tenant_id"""
        )
        todos = await conn.fetch(
            """SELECT tenant_id,
                      count(*) AS total,
                      count(*) FILTER (WHERE status='done') AS done,
                      count(*) FILTER (WHERE status='open' AND due_date < CURRENT_DATE) AS overdue
               FROM todos GROUP BY tenant_id"""
        )
        kpis = await conn.fetch("SELECT tenant_id, count(*) AS count FROM kpis GROUP BY tenant_id")
        vcbs = await conn.fetch("SELECT tenant_id, count(*) AS count FROM vcbs GROUP BY tenant_id")
        vcb_rocks = await conn.fetch(
            """SELECT r.tenant_id,
                      count(*) AS total,
                      count(*) FILTER (WHERE r.status='complete') AS done
               FROM rocks r JOIN workstreams w ON w.id = r.workstream_id
               GROUP BY r.tenant_id"""
        )

    # index the raw scans by tenant
    per = {str(o["id"]): _empty() for o in orgs}
    for r in rocks:
        m = per.get(str(r["tenant_id"]))
        if m: m["rocks"] = {"on_track": r["on_track"], "off_track": r["off_track"], "complete": r["complete"], "total": r["total"]}
    for r in issues:
        m = per.get(str(r["tenant_id"]))
        if m: m["issues"] = {"open": r["open"], "solved": r["solved"]}
    for r in todos:
        m = per.get(str(r["tenant_id"]))
        if m: m["todos"] = {"total": r["total"], "done": r["done"], "overdue": r["overdue"]}
    for r in kpis:
        m = per.get(str(r["tenant_id"]))
        if m: m["kpis"]["count"] = r["count"]
    for r in vcbs:
        m = per.get(str(r["tenant_id"]))
        if m: m["vcbs"]["count"] = r["count"]
    for r in vcb_rocks:
        m = per.get(str(r["tenant_id"]))
        if m: m["vcbs"]["rock_done"] = r["done"]; m["vcbs"]["rock_total"] = r["total"]

    # children map for the hierarchy roll-up
    visible_ids = {str(o["id"]) for o in orgs}
    children = {}
    for o in orgs:
        parent = str(o["parent_tenant_id"]) if o["parent_tenant_id"] else None
        children.setdefault(parent, []).append(str(o["id"]))

    # A "root" of the VISIBLE subtree = a tenant whose parent is null OR whose
    # parent is outside what this caller can see (e.g. a PortCo user whose parent
    # is the Fund they can't access). Without this, a non-admin's rollup summed
    # over an empty root set and showed all zeros.
    def is_root(o):
        p = str(o["parent_tenant_id"]) if o["parent_tenant_id"] else None
        return p is None or p not in visible_ids
    root_ids = [str(o["id"]) for o in orgs if is_root(o)]

    def rolled(tid):
        total = per[tid]
        for c in children.get(tid, []):
            total = _add(total, rolled(c))
        return total

    def pct(done, tot):
        return round(done / tot * 100) if tot else 0

    rows = []
    for o in orgs:
        tid = str(o["id"])
        self_m = per[tid]
        roll_m = rolled(tid)
        rows.append({
            "tenant_id": tid, "name": o["name"], "tenant_type": o["tenant_type"],
            "parent_tenant_id": str(o["parent_tenant_id"]) if o["parent_tenant_id"] else None,
            "self": self_m,
            "rollup": roll_m,   # self + all descendants
            "rock_completion_pct": pct(roll_m["rocks"]["complete"], roll_m["rocks"]["total"]),
            "vcb_progress_pct": pct(roll_m["vcbs"]["rock_done"], roll_m["vcbs"]["rock_total"]),
        })

    # fund-level total = sum of the visible roots' rollups (disjoint subtrees)
    fund_total = _empty()
    for rid in root_ids:
        fund_total = _add(fund_total, rolled(rid))

    fanout_ms = round((time.perf_counter() - t0) * 1000, 1)
    return {
        "approach": "query-time-fanout",
        "tenants_scanned": len(orgs),
        "fanout_ms": fanout_ms,
        "queries_run": 6,
        "tenants": rows,
        "fund_total": fund_total,
        "fund_rock_completion_pct": pct(fund_total["rocks"]["complete"], fund_total["rocks"]["total"]),
    }
