import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from './dto';
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private service: AuthService) {}
  @Post('login') login(@Body() dto: LoginDto) {
    return this.service.login(dto);
  }
  @Post('refresh') refresh(@Body() dto: RefreshDto) {
    return this.service.refresh(dto.refreshToken);
  }
  @Post('logout') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) logout(
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.logout(user.id);
  }
  @Get('me') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) me(@CurrentUser() user: AuthUser) {
    return this.service.me(user.id);
  }
}
