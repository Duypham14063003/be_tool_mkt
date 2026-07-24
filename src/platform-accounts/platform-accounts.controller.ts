import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { CreatePlatformAccountDto, UpdatePlatformAccountDto } from './dto';
import { PlatformAccountsService } from './platform-accounts.service';
import { TikTokAnalyticsService } from './tiktok-analytics.service';
import { OAuthService } from '../auth/oauth.service';
@ApiTags('platform-accounts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('platform-accounts')
export class PlatformAccountsController {
  constructor(
    private service: PlatformAccountsService,
    private analytics: TikTokAnalyticsService,
    private oauth: OAuthService,
  ) {}
  @Post('tiktok/connect-full')
  connectTikTokFully(@CurrentUser() user: AuthUser) {
    const state = this.oauth.createOAuthState(user.id);
    return this.analytics.connectOAuthAndAnalytics(
      user.id,
      this.oauth.getTiktokAuthUrl(state),
    );
  }
  @Get() list(@CurrentUser() u: AuthUser) {
    return this.service.list(u);
  }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.get(id, u);
  }
  @Post() create(@Body() d: CreatePlatformAccountDto, @CurrentUser() u: AuthUser) {
    return this.service.create(d, u);
  }
  @Patch(':id') update(
    @Param('id') id: string,
    @Body() d: UpdatePlatformAccountDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.service.update(id, d, u);
  }
  @Delete(':id') remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.remove(id, u);
  }
  @Post(':id/test-connection') test(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.test(id, u);
  }
  @Post(':id/reconnect') reconnect(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.update(id, { connectionStatus: 'CONNECTED' }, u);
  }
  @Get(':id/session-status') session(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.session(id, u);
  }
  @Post(':id/analytics-session/connect') async connectAnalytics(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.service.assertOwned(id, u);
    return this.analytics.captureSession(id);
  }
}
