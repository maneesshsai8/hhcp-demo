import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Auth, CurrentUser } from '../auth/current-user';
import { commandTag } from '../common/fund-access';
import { DatabaseService } from '../database/database.service';

class CreateTeamDto {
  @IsString() tenant_id!: string;
  @IsString() name!: string;
  @IsOptional() @IsArray() member_ids?: string[];
}

class AddMemberDto {
  @IsString() user_id!: string;
}

/** Teams + membership CRUD. Faithful port of backend/app/routers/teams.py. */
@Controller('teams')
@UseGuards(AuthGuard)
export class TeamsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async listTeams(@Query('tenant_id') tenantId: string | undefined, @Auth() user: CurrentUser) {
    const target = tenantId || user.active_tenant_id || null;
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT t.id, t.name, t.tenant_id, o.name AS tenant_name,
               (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
        FROM teams t
        JOIN organizations o ON o.id = t.tenant_id
        WHERE (${target}::uuid IS NULL OR t.tenant_id = ${target}::uuid)
        ORDER BY o.name, t.name
      `;
    });
  }

  @Post()
  @HttpCode(200)
  async createTeam(@Body() body: CreateTeamDto, @Auth() user: CurrentUser) {
    // No app-layer admin gate: RLS's WITH CHECK refuses the insert unless the
    // caller actually has access to that tenant.
    return this.db.scoped(user.user_id, async (sql) => {
      let row;
      try {
        const rows = await sql`
          INSERT INTO teams (tenant_id, name) VALUES (${body.tenant_id}, ${body.name})
          RETURNING id, name, tenant_id
        `;
        row = rows[0];
      } catch {
        throw new HttpException({ detail: "You don't have access to that tenant" }, HttpStatus.FORBIDDEN);
      }
      if (!row) {
        throw new HttpException({ detail: "You don't have access to that tenant" }, HttpStatus.FORBIDDEN);
      }
      for (const uid of body.member_ids ?? []) {
        if (uid) {
          await sql`
            INSERT INTO team_members (tenant_id, team_id, user_id)
            VALUES (${body.tenant_id}, ${row.id}, ${uid})
            ON CONFLICT (team_id, user_id) DO NOTHING
          `;
        }
      }
      return row;
    });
  }

  @Get(':teamId/members')
  async listMembers(@Param('teamId') teamId: string, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      return sql`
        SELECT tm.id, tm.user_id, u.name, u.email
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ${teamId}
        ORDER BY u.name
      `;
    });
  }

  @Post(':teamId/members')
  @HttpCode(200)
  async addMember(@Param('teamId') teamId: string, @Body() body: AddMemberDto, @Auth() user: CurrentUser) {
    return this.db.scoped(user.user_id, async (sql) => {
      // RLS on `teams` guarantees we only find a team we're allowed to touch.
      const team = (await sql`SELECT tenant_id FROM teams WHERE id = ${teamId}`)[0];
      if (!team) {
        throw new HttpException({ detail: 'Team not found or not accessible' }, HttpStatus.NOT_FOUND);
      }
      let row;
      try {
        row = (
          await sql`
            INSERT INTO team_members (tenant_id, team_id, user_id)
            VALUES (${team.tenant_id}, ${teamId}, ${body.user_id})
            ON CONFLICT (team_id, user_id) DO NOTHING
            RETURNING id
          `
        )[0];
      } catch {
        throw new HttpException({ detail: 'Could not add member' }, HttpStatus.BAD_REQUEST);
      }
      return { added: row != null, already_member: row == null };
    });
  }

  @Delete(':teamId/members/:userId')
  async removeMember(
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Auth() user: CurrentUser,
  ) {
    return this.db.scoped(user.user_id, async (sql) => {
      const res = await sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`;
      return { deleted: commandTag(res) };
    });
  }
}

@Module({ controllers: [TeamsController] })
export class TeamsModule {}
