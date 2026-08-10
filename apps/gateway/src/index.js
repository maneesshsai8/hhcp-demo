'use strict';
/**
 * HHCP gateway — the BE_SERVER / NODE_ROUTES strangler-fig switch (analysis §9).
 *
 * Both backends are interchangeable at the API boundary: same PostgreSQL, same
 * RLS, same REST contract. This proxy sits in front of both and routes each
 * request to whichever backend owns its path-prefix, so:
 *   - the frontend targets ONE stable URL (this gateway) and never sees a cutover;
 *   - a module is migrated by adding its prefix to NODE_ROUTES;
 *   - rollback is removing the prefix — a config change, no redeploy (§17);
 *   - unmigrated prefixes fall through to Python, so the app is always whole.
 *
 * Cookies are domain-scoped by the backends (path=/, no explicit domain), so the
 * browser attaches them to the gateway origin and auth works identically no
 * matter which backend answers.
 *
 * Routing precedence for a request path:
 *   1. if its prefix is in NODE_ROUTES  -> Node
 *   2. else if BE_SERVER=node           -> Node   (whole-app cutover)
 *   3. else                             -> Python (the default owner)
 */
const http = require('http');
const httpProxy = require('http-proxy');

const PORT = parseInt(process.env.GATEWAY_PORT || '8080', 10);
const PYTHON_TARGET = process.env.PYTHON_TARGET || 'http://localhost:8000';
const NODE_TARGET = process.env.NODE_TARGET || 'http://localhost:8001';
const BE_SERVER = (process.env.BE_SERVER || 'python').toLowerCase();

// Prefixes served by the Node backend. All 17 routers + the meeting WebSocket
// are now ported, so the default routes the whole API to Node. To roll a module
// back to Python, remove its prefix from NODE_ROUTES (config only, no redeploy).
const DEFAULT_NODE_ROUTES = [
  '/auth',
  '/announcements',
  '/audit',
  '/directory',
  '/federation',
  '/issues',
  '/meetings',
  '/organizations',
  '/reports',
  '/rocks',
  '/scorecards',
  '/seats',
  '/teams',
  '/todos',
  '/users',
  '/vcbs',
  '/vision',
  '/ws/meetings', // the live-meeting WebSocket
];
const NODE_ROUTES = (process.env.NODE_ROUTES
  ? process.env.NODE_ROUTES.split(',')
  : DEFAULT_NODE_ROUTES
)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.startsWith('/') ? s : '/' + s));

/** True if `pathname` is exactly `prefix` or a child path of it (segment boundary). */
function underPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/** Decide which backend owns this pathname. Returns a target URL string. */
function targetFor(pathname) {
  if (NODE_ROUTES.some((p) => underPrefix(pathname, p))) return NODE_TARGET;
  if (BE_SERVER === 'node') return NODE_TARGET;
  return PYTHON_TARGET;
}

const proxy = httpProxy.createProxyServer({
  changeOrigin: true, // rewrite Host to the target so upstream vhosts match
  xfwd: true, // add X-Forwarded-* so the backend can see the real client
  ws: true,
  proxyTimeout: 60000,
});

proxy.on('error', (err, req, res) => {
  // res is a ServerResponse for HTTP, or a Socket for WS upgrades.
  const msg = `Gateway: upstream error (${err.code || err.message})`;
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: msg }));
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
});

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  const target = targetFor(pathname);
  proxy.web(req, res, { target });
});

// WebSocket upgrades (e.g. /ws/meetings/{id}) route by the same rule.
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '/').split('?')[0];
  const target = targetFor(pathname);
  proxy.ws(req, socket, head, { target });
});

server.listen(PORT, '0.0.0.0', () => {
  /* eslint-disable no-console */
  console.log(`HHCP gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`  default owner : ${BE_SERVER}  (python=${PYTHON_TARGET}, node=${NODE_TARGET})`);
  console.log(`  node routes   : ${NODE_ROUTES.join(', ') || '(none)'}`);
  /* eslint-enable no-console */
});
