import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-memory fixed-window rate limiter. Faithful port of
 * backend/app/middleware.py RateLimitMiddleware: `limit` requests per `window`
 * seconds per client IP, 429 + Retry-After + X-RateLimit-* headers on rejection,
 * X-RateLimit-* on every allowed response. OPTIONS (CORS preflight) and /health
 * are never limited.
 *
 * PRODUCTION NOTE (analysis §11, ARCHITECTURE-GAPS §6): this per-process counter
 * does not survive horizontal scaling — swap for @nestjs/throttler with a Redis
 * store, or edge rate limiting at the gateway, before running multiple instances.
 * Installed as a Fastify onRequest hook so it applies to every route uniformly,
 * exactly like the Starlette middleware it ports.
 */
export function installRateLimit(fastify: FastifyInstance): void {
  const limit = parseInt(process.env.RATE_LIMIT ?? '200', 10);
  const windowSeconds = parseInt(process.env.RATE_LIMIT_WINDOW ?? '60', 10);
  const windowMs = windowSeconds * 1000;
  const hitsByClient = new Map<string, number[]>();

  fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // never rate-limit CORS preflight or health checks
    const path = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS' || path === '/health') {
      done();
      return;
    }

    const client = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const prior = hitsByClient.get(client) ?? [];
    const hits = prior.filter((t) => t > windowStart);

    if (hits.length >= limit) {
      const retryAfter = Math.floor((windowMs - (now - hits[0])) / 1000) + 1;
      hitsByClient.set(client, hits);
      reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .header('X-RateLimit-Limit', String(limit))
        .header('X-RateLimit-Remaining', '0')
        .send({ detail: `Rate limit exceeded (${limit}/${windowSeconds}s). Retry shortly.` });
      return; // reply already sent → short-circuits the request
    }

    hits.push(now);
    hitsByClient.set(client, hits);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(limit - hits.length));
    done();
  });
}
