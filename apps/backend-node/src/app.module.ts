import { Module } from '@nestjs/common';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DirectoryModule } from './directory/directory.module';
import { FederationModule } from './federation/federation.module';
import { HealthController } from './health.controller';
import { IssuesModule } from './issues/issues.module';
import { MeetingsModule } from './meetings/meetings.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportsModule } from './reports/reports.module';
import { RocksModule } from './rocks/rocks.module';
import { ScorecardsModule } from './scorecards/scorecards.module';
import { SeatsModule } from './seats/seats.module';
import { TeamsModule } from './teams/teams.module';
import { TodosModule } from './todos/todos.module';
import { UsersModule } from './users/users.module';
import { VcbsModule } from './vcbs/vcbs.module';
import { VisionModule } from './vision/vision.module';

/**
 * Root module. Phase 0 foundation (config + RLS-scoped DB layer) + auth, the
 * Phase 2 simple-CRUD modules, the Phase 3 Core-EOS modules + federation, and
 * the Phase 4 reports module. Remaining routers (meetings, announcements + the
 * realtime WebSocket) plug in here as they're ported — see
 * docs/BACKEND-MIGRATION-ANALYSIS.md §13.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    // --- Phase 2: simple CRUD ---
    DirectoryModule,
    VisionModule,
    TodosModule,
    TeamsModule,
    UsersModule,
    OrganizationsModule,
    // --- Phase 3: Core EOS + federation ---
    ScorecardsModule,
    RocksModule,
    IssuesModule,
    VcbsModule,
    SeatsModule,
    AuditModule,
    FederationModule,
    MeetingsModule,
    // --- Phase 4: reports ---
    ReportsModule,
    // --- Phase 5: async backbone (announcements fan-out via the worker) ---
    AnnouncementsModule,
    // --- Phase 6: realtime meeting rooms (WebSocket) ---
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
