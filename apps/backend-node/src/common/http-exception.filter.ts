import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

/**
 * Formats every error as `{ "detail": "..." }` — exactly the shape FastAPI's
 * HTTPException produces and the frontend reads (`body.detail` in
 * frontend/lib/api.js). This is what keeps error responses contract-compatible
 * so the frontend needs zero changes.
 */
@Catch()
export class DetailExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        detail = res;
      } else if (res && typeof res === 'object') {
        const body = res as Record<string, unknown>;
        // Nest's ValidationPipe puts an array/string in `message`; HttpException
        // thrown with { detail } keeps that. Prefer an explicit `detail`.
        if (typeof body.detail === 'string') {
          detail = body.detail;
        } else if (Array.isArray(body.message)) {
          detail = body.message.join('; ');
        } else if (typeof body.message === 'string') {
          detail = body.message;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    reply.status(status).send({ detail });
  }
}
