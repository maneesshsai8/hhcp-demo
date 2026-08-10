import { Controller, Get } from '@nestjs/common';

/** Liveness probe. Matches the Python backend's GET /health exactly. */
@Controller('health')
export class HealthController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}
