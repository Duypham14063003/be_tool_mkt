import { Injectable } from '@nestjs/common';
import { Platform } from '@prisma/client';
import { EncryptionService } from '../../common/encryption.service';
import { PrismaService } from '../../database/prisma.service';
import { SocialProvider } from '../social-provider';
import { FacebookProvider } from './facebook.provider';
import { TiktokProvider } from './tiktok.provider';
@Injectable()
export class SocialProviderFactory {
  constructor(
    private readonly facebook: FacebookProvider,
    private readonly tiktok: TiktokProvider,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}
  async getForAccount(platformAccountId: string): Promise<{
    provider: SocialProvider;
    externalAccountId: string;
    accessToken: string;
  }> {
    const account = await this.prisma.platformAccount.findUniqueOrThrow({
      where: { id: platformAccountId },
      select: {
        platform: true,
        externalAccountId: true,
        encryptedAccessToken: true,
        connectionStatus: true,
      },
    });
    if (!account.encryptedAccessToken) {
      throw new Error(`PlatformAccount ${platformAccountId} has no access token stored`);
    }
    const accessToken = this.encryption.decrypt(account.encryptedAccessToken);
    const provider: SocialProvider =
      account.platform === Platform.FACEBOOK ? this.facebook : this.tiktok;
    return {
      provider,
      externalAccountId: account.externalAccountId,
      accessToken,
    };
  }
}
