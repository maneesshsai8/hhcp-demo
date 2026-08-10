import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Module,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { DatabaseService } from '../database/database.service';

/**
 * GET /audit — the compliance audit trail. Faithful port of
 * backend/app/routers/audit.py.
 *
 * `audit_log` is RLS-free, so access is gated at the app layer. The Python does
 * the gate inline: fund admins OR fund viewers may read (COALESCE(is_fund_admin,
 * false) OR COALESCE(is_fund_viewer, false)) — the same predicate as
 * requireFundView, but with the endpoint-specific 403 message reproduced here to
 * stay 1:1. The query runs on the scoped connection exactly as the Python's
 * `get_scoped_connection(user_id)`.
 */
@Controller('audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listAudit(
    @Auth() user: CurrentUser,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('limit') limitParam?: string,
  ) {
    // FastAPI: `limit: int = Query(default=200, le=1000)` — default 200, reject
    // non-integers and values > 1000 with a 422.
    let limit = 200;
    if (limitParam !== undefined) {
      if (!/^-?\d+$/.test(limitParam.trim())) {
        throw new HttpException(
          { detail: 'value is not a valid integer' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      limit = parseInt(limitParam.trim(), 10);
    }
    if (limit > 1000) {
      throw new HttpException(
        { detail: 'ensure this value is less than or equal to 1000' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.db.scoped(user.user_id, async (sql) => {
      const gate = await sql`
        SELECT COALESCE(is_fund_admin, false) OR COALESCE(is_fund_viewer, false) AS ok
        FROM users WHERE id = ${user.user_id}
      `;
      if (!gate[0]?.ok) {
        throw new HttpException(
          { detail: 'Fund-level access required to view the audit log' },
          HttpStatus.FORBIDDEN,
        );
      }
      return sql`
        SELECT id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at
        FROM audit_log
        WHERE (${actorId ?? null}::uuid IS NULL OR actor_id = ${actorId ?? null}::uuid)
          AND (${action ?? null}::text IS NULL OR action = ${action ?? null}::text)
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    });
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
