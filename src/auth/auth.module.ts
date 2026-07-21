import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller'; import { AuthService } from './auth.service'; import { JwtStrategy } from './jwt.strategy';
@Module({ imports: [PassportModule, JwtModule.registerAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => ({ secret: c.get('JWT_ACCESS_SECRET') }) })], controllers: [AuthController], providers: [AuthService, JwtStrategy], exports: [AuthService] })
export class AuthModule {}
