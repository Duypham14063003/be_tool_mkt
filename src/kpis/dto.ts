import { PeriodType, Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateKpiDto {
  @IsEnum(Platform) platform!: Platform;
  @IsEnum(PeriodType) periodType!: PeriodType;
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
  @IsString() metricName!: string;
  @Type(() => Number) @IsNumber() @Min(0.01) targetValue!: number;
}

export class UpdateKpiDto {
  @IsOptional() @IsEnum(PeriodType) periodType?: PeriodType;
  @IsOptional() @IsDateString() periodStart?: string;
  @IsOptional() @IsDateString() periodEnd?: string;
  @IsOptional() @IsString() metricName?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) targetValue?: number;
}
