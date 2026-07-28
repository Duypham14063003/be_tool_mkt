import { PeriodType, Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsNumber, IsOptional, Min } from 'class-validator';
import { KPI_METRICS } from './kpi.constants';

export class CreateKpiDto {
  @IsEnum(Platform) platform!: Platform;
  @IsEnum(PeriodType) periodType!: PeriodType;
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
  @IsIn(KPI_METRICS) metricName!: string;
  @Type(() => Number) @IsNumber() @Min(0.01) targetValue!: number;
}

export class UpdateKpiDto {
  @IsOptional() @IsEnum(PeriodType) periodType?: PeriodType;
  @IsOptional() @IsDateString() periodStart?: string;
  @IsOptional() @IsDateString() periodEnd?: string;
  @IsOptional() @IsIn(KPI_METRICS) metricName?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) targetValue?: number;
}
