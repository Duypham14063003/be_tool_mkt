import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class FacebookImportRowDto {
  @IsOptional() @IsString() @MaxLength(255) externalPostId?: string;
  @IsDateString() publishedAt!: string;
  @IsString() @MaxLength(50) contentType!: string;
  @IsOptional() @IsString() @MaxLength(10000) caption?: string;
  @IsOptional() @IsString() @MaxLength(2000) postUrl?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) durationSeconds?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reach?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) views?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) interactions?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reactions?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) comments?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) shares?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) saves?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) viewers?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) view3Seconds?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) view1Minute?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) totalWatchTimeSeconds?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) averageWatchTimeSeconds?: number;
}

export class CreateFacebookImportDto {
  @IsUUID() platformAccountId!: string;
  @IsString() @MaxLength(255) fileName!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => FacebookImportRowDto)
  rows!: FacebookImportRowDto[];
}
