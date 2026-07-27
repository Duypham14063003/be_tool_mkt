import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() password!: string;
  @IsOptional() @IsString() @MaxLength(255) device_id?: string;
  @IsOptional() @IsString() @MaxLength(255) device_name?: string;
}
export class RefreshDto {
  @IsString() refreshToken!: string;
}
