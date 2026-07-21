import { ConnectionStatus, Platform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUrl } from 'class-validator';
export class CreatePlatformAccountDto {
  @IsEnum(Platform) platform!: Platform;
  @IsString() accountName!: string;
  @IsString() externalAccountId!: string;
  @IsOptional() @IsString() accessToken?: string;
  @IsOptional() @IsString() refreshToken?: string;
}
export class UpdatePlatformAccountDto {
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @IsEnum(ConnectionStatus) connectionStatus?: ConnectionStatus;
}
