import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SecurityService } from './security';
import { SupabaseAuthService } from './supabase-auth';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SecurityService, SupabaseAuthService, AuthGuard],
  exports: [SecurityService, SupabaseAuthService, AuthGuard],
})
export class AuthModule {}
