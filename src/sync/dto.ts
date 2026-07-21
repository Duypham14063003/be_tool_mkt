import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';
export class CreateSyncDto {
  @IsUUID() platformAccountId!: string;
  @IsDateString() dateFrom!: string;
  @IsDateString() dateTo!: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) forceRefresh = false;
}
