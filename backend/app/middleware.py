"""
A lightweight taste of the API-gateway concern, in-process:
  - per-client fixed-window rate limiting (429 + Retry-After when exceeded)
  - security headers on every response

A real deployment would put these at an edge gateway (nginx / Kong / API
Gateway) rather than in the app — see ARCHITECTURE-GAPS.md. This version proves
the behavior without extra infrastructure.
"""
import time
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "0",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Fixed-window limiter: `limit` requests per `window` seconds per client IP."""

    def __init__(self, app, limit: int = 200, window: int = 60):
        super().__init__(app)
        self.limit = limit
        self.window = window
        self._hits: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request, call_next):
        # never rate-limit CORS preflight or health checks
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)

        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window_start = now - self.window
        hits = [t for t in self._hits[client] if t > window_start]

        if len(hits) >= self.limit:
            retry_after = int(self.window - (now - hits[0])) + 1
            resp = JSONResponse(
                status_code=429,
                content={"detail": f"Rate limit exceeded ({self.limit}/{self.window}s). Retry shortly."},
            )
            resp.headers["Retry-After"] = str(retry_after)
            resp.headers["X-RateLimit-Limit"] = str(self.limit)
            resp.headers["X-RateLimit-Remaining"] = "0"
            return resp

        hits.append(now)
        self._hits[client] = hits
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.limit)
        response.headers["X-RateLimit-Remaining"] = str(self.limit - len(hits))
        return response
