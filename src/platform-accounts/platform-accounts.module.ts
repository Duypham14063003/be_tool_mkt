import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformAccountsController } from './platform-accounts.controller';
import { PlatformAccountsService } from './platform-accounts.service';
import { TikTokAnalyticsService } from './tiktok-analytics.service';
@Module({
  imports: [AuthModule],
  controllers: [PlatformAccountsController],
  providers: [PlatformAccountsService, TikTokAnalyticsService],
  exports: [PlatformAccountsService, TikTokAnalyticsService],
})
export class PlatformAccountsModule {}
