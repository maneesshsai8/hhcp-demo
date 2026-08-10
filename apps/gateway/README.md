# @hhcp/gateway

The `BE_SERVER` / `NODE_ROUTES` reverse proxy from the migration plan (§9). One
stable URL in front of both backends; each request is routed to Python or Node
by its path-prefix.

## Why

Both backends share the same PostgreSQL + RLS + REST contract, so they are
interchangeable at the API boundary. The gateway makes the strangler-fig
migration invisible to the frontend:

- Point the frontend's `NEXT_PUBLIC_API_BASE` at the gateway (e.g. `:8080`).
- Migrate a module by adding its prefix to `NODE_ROUTES`.
- Roll it back by removing the prefix — **config only, no redeploy, seconds** (§17).
- Anything not routed to Node falls through to Python, so the app is always whole
  (no 404s for unported modules, unlike pointing the frontend straight at `:8001`).

## Run

```bash
cp .env.example .env
npm install                      # from the repo root (workspaces)
npm start -w @hhcp/gateway       # listens on GATEWAY_PORT (default 8080)
```

Then run Python on `:8000` and Node on `:8001`, and set the frontend
`NEXT_PUBLIC_API_BASE=http://localhost:8080`.

## Routing rule

For each request path (HTTP **and** WebSocket upgrades):

1. prefix in `NODE_ROUTES` → **Node** (`:8001`)
2. else if `BE_SERVER=node` → **Node** (whole-app cutover)
3. else → **Python** (`:8000`, the default owner)

Cookies work identically through the proxy because the backends set them with
`path=/` and no explicit domain, so the browser scopes them to the gateway
origin. WebSocket upgrades (`/ws/meetings/{id}`) follow the same rule.
