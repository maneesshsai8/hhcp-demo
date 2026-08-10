import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { auditLog } from '../common/audit';
import { boolQuery, requireFundAdmin, requireFundView } from '../common/fund-access';
import { DatabaseService } from '../database/database.service';
import { SecurityService } from '../auth/security';

class CreateUserDto {
  @IsString() name!: string;
  @IsString() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsBoolean() is_fund_admin?: boolean;
  @IsOptional() @IsBoolean() is_fund_viewer?: boolean;
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() department?: string | null;
  @IsOptional() @IsString() reports_to?: string | null;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() title?: string | null;
  @IsOptional() @IsString() department?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean | null;
  @IsOptional() @IsString() reports_to?: string | null;
}

class ImportUsersDto {
  @IsString() csv!: string;
}

/** Minimal CSV parser (header row + comma-separated), handling basic double-quotes.
    Mirrors csv.DictReader for the demo's simple name,email,title,department input. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = splitRow(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = cells[i] ?? ''));
    return rec;
  });
}

function validatePassword(pw: string): void {
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw) || /^[A-Za-z0-9]*$/.test(pw)) {
    throw new HttpException(
      { detail: 'Password must be at least 8 characters and include a letter, a number, and a symbol.' },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** Fund-level user directory + provisioning. Faithful port of users.py. */
@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly db: DatabaseService, private readonly security: SecurityService) {}

  @Get()
  async listUsers(@Auth() user: CurrentUser, @Query('active_only') activeOnly?: string) {
    const onlyActive = boolQuery(activeOnly);
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundView(sql, user.user_id);
      return sql`
        SELECT u.id, u.name, u.email, u.is_fund_admin, u.is_fund_viewer, u.title, u.department, u.is_active,
               (SELECT name FROM users m WHERE m.id = u.reports_to) AS reports_to_name,
               (SELECT count(*) FROM tenant_memberships tm WHERE tm.user_id = u.id) AS grant_count,
               (SELECT count(*) FROM team_members tmb WHERE tmb.user_id = u.id) AS team_count
        FROM users u
        WHERE (NOT ${onlyActive} OR u.is_active)
        ORDER BY u.name
      `;
    });
  }

  @Post()
  @HttpCode(200)
  async createUser(@Body() body: CreateUserDto, @Auth() user: CurrentUser) {
    validatePassword(body.password);
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      const dup = await sql`SELECT 1 FROM users WHERE email = ${body.email}`;
      if (dup[0]) {
        throw new HttpException({ detail: 'A user with that email already exists' }, HttpStatus.CONFLICT);
      }
      const rows = await sql`
        INSERT INTO users (name, email, password_hash, is_fund_admin, is_fund_viewer, title, department, reports_to)
        VALUES (${body.name}, ${body.email}, ${this.security.hashPassword(body.password)},
                ${body.is_fund_admin ?? false}, ${body.is_fund_viewer ?? false},
                ${body.title ?? null}, ${body.department ?? null}, ${body.reports_to ?? null})
        RETURNING id, name, email
      `;
      const row = rows[0];
      await auditLog(sql, user.user_id, 'user.create', {
        entityType: 'user',
        entityId: String(row.id),
        detail: `${body.name} <${body.email}>`,
      });
      return { ...row, is_fund_admin: body.is_fund_admin ?? false };
    });
  }

  @Patch(':userId')
  async updateUser(@Param('userId') userId: string, @Body() body: UpdateUserDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      const rows = await sql`
        UPDATE users SET
            name       = COALESCE(${body.name ?? null}, name),
            title      = COALESCE(${body.title ?? null}, title),
            department = COALESCE(${body.department ?? null}, department),
            is_active  = COALESCE(${body.is_active ?? null}, is_active),
            reports_to = COALESCE(${body.reports_to ?? null}, reports_to)
        WHERE id = ${userId}
        RETURNING id, name, email, is_active
      `;
      const row = rows[0];
      if (!row) throw new HttpException({ detail: 'User not found' }, HttpStatus.NOT_FOUND);
      if (body.is_active != null) {
        const action = body.is_active ? 'user.activate' : 'user.deactivate';
        await auditLog(sql, user.user_id, action, { entityType: 'user', entityId: String(row.id), detail: row.name });
      } else {
        await auditLog(sql, user.user_id, 'user.edit', { entityType: 'user', entityId: String(row.id), detail: row.name });
      }
      return row;
    });
  }

  @Post('import')
  @HttpCode(200)
  async importUsers(@Body() body: ImportUsersDto, @Auth() user: CurrentUser) {
    let created = 0;
    let skipped = 0;
    const records = parseCsv(body.csv);
    return this.db.scoped(user.user_id, async (sql) => {
      await requireFundAdmin(sql, user.user_id);
      for (const r of records) {
        const email = (r.email ?? '').trim().toLowerCase();
        const name = (r.name ?? '').trim();
        if (!email || !name) continue;
        const exists = await sql`SELECT 1 FROM users WHERE lower(email) = ${email}`;
        if (exists[0]) {
          skipped++;
          continue;
        }
        await sql`
          INSERT INTO users (name, email, password_hash, title, department)
          VALUES (${name}, ${email}, ${this.security.hashPassword('ChangeMe123!')},
                  ${(r.title ?? '').trim() || null}, ${(r.department ?? '').trim() || null})
        `;
        created++;
      }
      await auditLog(sql, user.user_id, 'user.import', { detail: `${created} created, ${skipped} skipped` });
      return { created, skipped };
    });
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
