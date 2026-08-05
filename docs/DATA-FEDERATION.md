# Data Federation Approach (POC — Discussion Point 5)

**The question:** how does data move / aggregate across the Fund → PortCo → Add-on
tenant hierarchy for Phase 2 portfolio reporting, without Phase 1 events being
wrong or missing later?

## The three approaches

| Approach | How it works | Pros | Cons |
|---|---|---|---|
| **Query-time fan-out** | At read time, scan every accessible tenant and aggregate on the fly | Simplest; no extra infra; always fresh | Slower as the portfolio grows |
| **Event-driven aggregation** | Each change emits an event; a reporting store keeps running totals | Scales; decoupled reporting | More moving parts to build/test now |
| **Scheduled materialized view** | A job pre-computes the rollup into a table on a schedule | Simple; fast reads | Only as fresh as the last refresh |

**Recommendation:** prototype **query-time fan-out first** — fastest path to real
signal; if it doesn't scale, that's still useful information before committing further.

## What this POC ships

**Endpoint:** `GET /federation/rollup` (`backend/app/routers/federation.py`)

- Runs **6 `GROUP BY tenant_id` queries** (rocks, issues, todos, kpis, vcbs, vcb-linked-rocks).
- RLS scopes every scan to the caller's accessible subtree automatically — no tenant
  filter is written in the reporting query. A fund admin federates all 10 tenants;
  a PortCo user (e.g. Priya) federates only her ~3-tenant subtree. Same query, correct
  isolation.
- Rolls each tenant's numbers up the hierarchy in the app: a **PortCo row includes its
  add-on acquisitions**, the **Fund row is the whole portfolio**.
- Returns `fanout_ms` + `tenants_scanned` so the "does it scale?" question is
  **observable**, not hypothetical (measured ~26ms across 10 tenants in the demo).

**UI:** `/dashboard/portfolio` ("Portfolio Rollup", fund-admin / fund-viewer only)

- Live telemetry strip (tenants scanned · fan-out ms · queries run) with a **Re-run**
  button so you can watch cost as data grows.
- Fund-level summary cards + a per-tenant hierarchy table (each row = self + descendants).
- An explainer of all three approaches for the architecture conversation.

## Why the other two are "seeded, not built"

The design deliberately keeps the door open so **Phase 1 events aren't wrong or
missing later**:

- **Event-driven:** every meaningful change already writes an event to `audit_log`
  from day one — `scorecard.entry`, `rock.status`, `vcb.status`, `issue.status`,
  grants, logins. A Phase 2 consumer can fold that existing stream into running
  aggregates without re-scanning; the events exist now, so no history is lost.
- **Materialized view:** the exact aggregation in `/federation/rollup` could be
  written to a table by a nightly job; reads then become a single indexed lookup.
  Because the fan-out query already defines the shape, promoting it to a materialized
  view is a mechanical change, not a redesign.

## Migration path

1. **Now (POC):** query-time fan-out. Ship it, measure `fanout_ms` in real use.
2. **If reads slow down:** add a scheduled materialized view of the same rollup
   (fast reads, accept minutes-old staleness) — cheapest next step.
3. **If freshness matters at scale:** switch the reporting store to consume the
   `audit_log` event stream (already emitted) for near-real-time aggregates.

The key property: each step reuses the previous one's query/event shape, so we never
have to backfill missing Phase 1 data.
