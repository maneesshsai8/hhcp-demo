# @hhcp/contract-tests

The golden-response parity harness (analysis §16). It runs the same requests
against **both** backends — which share one PostgreSQL — and diffs the results,
turning "the Node port is faithful" from an assertion into a check.

## What it verifies

- **Read parity (§16.1):** every module's primary `GET` returns a byte-identical
  body from Python and Node (both read the same rows from the same DB, so ids and
  timestamps match too; only request-time fields like `fanout_ms` are normalized).
- **Security parity (§16.3):** no-context → 401; cross-tenant `tenant_id` in the
  URL → empty list; `switch-tenant` to a non-granted tenant → 403.
- **Behavioral parity (§16.4, `--behavioral`):** meeting idempotency replay and
  optimistic-lock 409, when seed fixtures are supplied.

## Prerequisites

Both backends running against the **same seeded database**, both in
`AUTH_PROVIDER=local`:

- Python (reference): `:8000`
- Node (port): `:8001`
- A seeded admin login (default `admin@hiddenharbor.com` / `Demo1234!`)

## Run

```bash
PY_BASE=http://localhost:8000 NODE_BASE=http://localhost:8001 \
ADMIN_EMAIL=admin@hiddenharbor.com ADMIN_PASSWORD=Demo1234! \
npm test -w @hhcp/contract-tests

# behavioral cases (need fixtures):
FIXTURE_TENANT_ID=<uuid> FIXTURE_MEETING_ID=<uuid> \
npm run test:behavioral -w @hhcp/contract-tests
```

Exit code is non-zero if any case fails — wire it into CI to run against both
backends on every PR (§9), so parity can't silently regress.

> Note: this diffs live responses. It complements — but does not replace — an
> OpenAPI-schema diff of `packages/api-contract/api-types.d.ts`. Regenerating the
> spec from NestJS would require annotating every DTO with `@nestjs/swagger`;
> until then, this response-level harness is the parity gate.
