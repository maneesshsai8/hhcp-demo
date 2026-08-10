import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

/**
 * The authenticated principal. Faithful port of dependencies.CurrentUser:
 * proves identity only — it does NOT decide what the user can see. That is left
 * to Postgres RLS once inside a scoped connection (Option B).
 */
export class CurrentUser {
  constructor(
    public readonly user_id: string,
    public readonly active_tenant_id: string | null,
  ) {}
}

/** `@Auth() user: CurrentUser` — reads the principal the AuthGuard attached. */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUser => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { currentUser: CurrentUser }>();
    return req.currentUser;
  },
);
