import { Platform, ReportFormat } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
export class CreateReportDto {
  @IsOptional() @IsEnum(Platform) platform?: Platform;
  @IsDateString() dateFrom!: string;
  @IsDateString() dateTo!: string;
  @IsEnum(ReportFormat) format!: ReportFormat;
}
