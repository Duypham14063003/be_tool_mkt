import { Injectable } from '@nestjs/common';
import { Platform } from '@prisma/client';
import { KpiCalculatorService } from '../kpis/kpi-calculator.service';
import { NormalizedPost, SocialProvider } from './social-provider';
@Injectable()
export class FakeSocialProvider implements SocialProvider {
  constructor(private calc: KpiCalculatorService) {}
  async getPosts(accountId: string, from: Date, to: Date, _accessToken?: string): Promise<NormalizedPost[]> {
    const platform = accountId.includes('tiktok') ? Platform.TIKTOK : Platform.FACEBOOK;
    return Array.from({ length: 10 }, (_, i) => {
      const views = BigInt(1000 + i * 100),
        reach = platform === 'FACEBOOK' ? BigInt(800 + i * 80) : null,
        likes = BigInt(50 + i),
        comments = BigInt(10 + i),
        shares = BigInt(5 + i),
        saves = platform === 'TIKTOK' ? BigInt(3 + i) : null,
        reactions = platform === 'FACEBOOK' ? likes : null;
      const engagementRate =
        platform === 'FACEBOOK'
          ? this.calc.facebookEngagement(
              Number(reactions),
              Number(comments),
              Number(shares),
              Number(reach),
            )
          : this.calc.tiktokEngagement(
              Number(likes),
              Number(comments),
              Number(shares),
              Number(saves),
              Number(views),
            );
      return {
        externalPostId: `fake-${accountId}-${i}`,
        platform,
        contentType: platform === 'TIKTOK' ? 'VIDEO' : i % 2 ? 'VIDEO' : 'POST',
        caption: `Development seed post ${i + 1}`,
        postUrl: null,
        thumbnailUrl: null,
        durationSeconds: platform === 'TIKTOK' ? 30 + i : null,
        publishedAt: new Date(Math.max(from.getTime(), to.getTime() - i * 86400000)),
        rawData: { provider: 'FAKE' },
        metric: {
          views,
          reach,
          viewers: null,
          reactions,
          likes,
          comments,
          shares,
          saves,
          view3Seconds: platform === 'FACEBOOK' ? views : null,
          view1Minute: null,
          engagementRate,
          rawData: { sources: { views: 'API', likes: 'API' } },
        },
      };
    });
  }
}
