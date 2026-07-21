import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { KpisModule } from '../kpis/kpis.module';
import { PlatformAccountsModule } from '../platform-accounts/platform-accounts.module';
import { FakeSocialProvider } from './fake-social.provider';
import { FacebookProvider } from './providers/facebook.provider';
import { SocialProviderFactory } from './providers/social-provider.factory';
import { TiktokProvider } from './providers/tiktok.provider';
import { SyncController } from './sync.controller';
import { SyncProcessor } from './sync.processor';
import { SyncService } from './sync.service';
@Module({
  imports: [
    BullModule.registerQueue({ name: 'social-sync' }),
    PlatformAccountsModule,
    CommonModule,
    KpisModule,
  ],
  controllers: [SyncController],
  providers: [
    SyncService,
    SyncProcessor,
    FakeSocialProvider,
    FacebookProvider,
    TiktokProvider,
    SocialProviderFactory,
  ],
})
export class SyncModule {}

