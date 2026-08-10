import { Module } from '@nestjs/common';
import { MeetingRealtime } from './realtime.gateway';

/**
 * Provides the in-process meeting-room WebSocket manager. SecurityService and
 * DatabaseService are injected from the @Global() AuthModule / DatabaseModule,
 * so no extra imports are needed here. Export it so main.ts can resolve the
 * instance (`app.get(MeetingRealtime)`) and call `.attach(server)`.
 */
@Module({
  providers: [MeetingRealtime],
  exports: [MeetingRealtime],
})
export class RealtimeModule {}
