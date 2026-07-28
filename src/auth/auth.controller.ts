import { Body, Controller, Get, Headers, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from './dto';
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private service: AuthService) {}
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Ip() ipAddress: string, @Headers('user-agent') userAgent?: string) {
    return this.service.login(dto, { ipAddress, userAgent });
  }
  @Post('refresh') refresh(@Body() dto: RefreshDto) {
    return this.service.refresh(dto.refreshToken);
  }
  @Post('logout') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) logout(
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.logout(user.id, user.sessionId);
  }
  @Get('me') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) me(@CurrentUser() user: AuthUser) {
    return this.service.me(user.id);
  }
}
