import 'reflect-metadata';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { DetailExceptionFilter } from './common/http-exception.filter';
import { installRateLimit } from './common/rate-limit';
import { ConfigService } from './config/config.service';
import { MeetingRealtime } from './realtime/realtime.gateway';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // httpOnly cookie support (read via request.cookies, set via reply.setCookie).
  await app.register(fastifyCookie as never);

  // Rate limiting (200/60s per IP) — faithful port of middleware.py.
  installRateLimit(app.getHttpAdapter().getInstance());

  // Security headers on every response — faithful port of
  // backend/app/middleware.py SecurityHeadersMiddleware. Uses setdefault
  // semantics (only set if not already present), same as the Python version,
  // and applies to error responses too since onSend runs for all replies.
  const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-XSS-Protection': '0',
  };
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req: unknown, reply: { getHeader(k: string): unknown; header(k: string, v: string): void }, _payload: unknown, done: () => void) => {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        if (reply.getHeader(k) === undefined) reply.header(k, v);
      }
      done();
    });

  // CORS mirrors backend/app/main.py: localhost/127.0.0.1:<port> only, credentials
  // on (for cookie auth), and the same exposed headers the frontend/reports rely
  // on. With credentials, the allow-origin and allow-headers responses must be
  // specific values — NOT the literal "*" — or the browser rejects the preflight.
  // Leaving `methods`/`allowedHeaders` unset makes @fastify/cors reflect the
  // request's method and Access-Control-Request-Headers (matching how FastAPI's
  // CORSMiddleware behaves with allow_headers=["*"] + allow_credentials=True).
  app.enableCors({
    origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/,
    credentials: true,
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After', 'X-Report-Engine'],
  });

  // Validate/transform DTOs. errorHttpStatusCode=422 matches FastAPI/Pydantic.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );

  // Every error becomes `{ "detail": "..." }` — the exact shape the frontend reads.
  app.useGlobalFilters(new DetailExceptionFilter());

  const config = app.get(ConfigService);

  // Wire the in-process meeting-room WebSocket manager onto the raw Node server
  // (faithful port of backend/app/realtime.py's /ws/meetings/{id}). It filters
  // upgrades by path and leaves non-matching upgrades alone.
  const httpServer = app.getHttpAdapter().getInstance().server;
  app.get(MeetingRealtime).attach(httpServer);

  await app.listen(config.PORT, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`HHCP backend-node listening on http://0.0.0.0:${config.PORT} (auth=${config.AUTH_PROVIDER})`);
}

void bootstrap();
