import { IsOptional, IsString } from 'class-validator';

/**
 * Request DTOs. Kept intentionally loose (string-only) to match the Python
 * Pydantic models (`email: str`, etc.), so the Node backend accepts exactly the
 * same inputs the FastAPI backend accepts — no stricter validation that would
 * reject a request the frontend currently sends.
 */

export class LoginDto {
  @IsString()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshDto {
  @IsOptional()
  @IsString()
  refresh_token?: string;
}

export class SwitchTenantDto {
  @IsOptional()
  @IsString()
  tenant_id?: string | null;
}

export class SupabaseSessionDto {
  @IsString()
  access_token!: string;

  @IsString()
  refresh_token!: string;
}
