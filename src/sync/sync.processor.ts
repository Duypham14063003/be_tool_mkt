import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { FakeSocialProvider } from './fake-social.provider';
import { SocialProviderFactory } from './providers/social-provider.factory';

@Processor('social-sync', { concurrency: 4 })
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    private prisma: PrismaService,
    private fakeProvider: FakeSocialProvider,
    private providerFactory: SocialProviderFactory,
    private config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<{ syncJobId: string }>): Promise<{ processed: number }> {
    const sync = await this.prisma.syncJob.update({
      where: { id: job.data.syncJobId },
      data: { status: 'RUNNING', startedAt: new Date(), progress: 1 },
      include: { platformAccount: true },
    });

    try {
      // ─── Chọn provider: real (Facebook/TikTok API) hoặc fake (dev) ─────────
      const mode = this.config.get<string>('SOCIAL_PROVIDER_MODE', 'fake');
      let posts;

      if (mode === 'real') {
        const { provider, externalAccountId, accessToken } =
          await this.providerFactory.getForAccount(sync.platformAccountId);

        posts = await provider.getPosts(
          externalAccountId,
          sync.dateFrom,
          sync.dateTo,
          accessToken,
        );
      } else {
        posts = await this.fakeProvider.getPosts(
          sync.platformAccount.externalAccountId,
          sync.dateFrom,
          sync.dateTo,
        );
      }

      await this.prisma.syncJob.update({
        where: { id: sync.id },
        data: { totalItems: posts.length },
      });

      for (let i = 0; i < posts.length; i++) {
        const { metric, ...postData } = posts[i];

        // Lấy extended fields từ rawData (TikTok inject ở đây)
        const extended = (metric.rawData as Record<string, unknown>)['_extended'] as
          | Record<string, unknown>
          | undefined;

        const metricData: Prisma.PostMetricUncheckedCreateInput & Record<string, unknown> = {
          postId: '', // sẽ gán sau
          metricDate: postData.publishedAt,
          views: metric.views,
          reach: metric.reach,
          viewers: metric.viewers,
          reactions: metric.reactions,
          likes: metric.likes,
          comments: metric.comments,
          shares: metric.shares,
          saves: metric.saves,
          view3Seconds: metric.view3Seconds,
          view1Minute: metric.view1Minute,
          engagementRate:
            metric.engagementRate === null ? null : new Prisma.Decimal(metric.engagementRate),
          rawData: metric.rawData as Prisma.InputJsonValue,
          // ─── TikTok extended metrics ────────────────────────────────────
          ...(extended
            ? {
                totalWatchTimeSeconds:
                  extended.totalWatchTimeSeconds != null
                    ? new Prisma.Decimal(extended.totalWatchTimeSeconds as number)
                    : null,
                averageWatchTimeSeconds:
                  extended.averageWatchTimeSeconds != null
                    ? new Prisma.Decimal(extended.averageWatchTimeSeconds as number)
                    : null,
                completionRate:
                  extended.completionRate != null
                    ? new Prisma.Decimal(extended.completionRate as number)
                    : null,
                newFollowers: extended.newFollowers as bigint | null,
                trafficSource: (extended.trafficSource as string) ?? null,
                maleRate:
                  extended.maleRate != null
                    ? new Prisma.Decimal(extended.maleRate as number)
                    : null,
                femaleRate:
                  extended.femaleRate != null
                    ? new Prisma.Decimal(extended.femaleRate as number)
                    : null,
                mainAgeGroup: (extended.mainAgeGroup as string) ?? null,
                mainLocation: (extended.mainLocation as string) ?? null,
              }
            : {}),
        };

        await this.prisma.$transaction(async (tx) => {
          const post = await tx.post.upsert({
            where: {
              platformAccountId_externalPostId: {
                platformAccountId: sync.platformAccountId,
                externalPostId: postData.externalPostId,
              },
            },
            create: {
              ...postData,
              rawData: postData.rawData as Prisma.InputJsonValue,
              platformAccountId: sync.platformAccountId,
            },
            update: {
              caption: postData.caption,
              rawData: postData.rawData as Prisma.InputJsonValue,
              publishedAt: postData.publishedAt,
            },
          });

          const { postId: _ignored, ...metricWithoutPostId } = metricData as typeof metricData & { postId: string };

          await tx.postMetric.upsert({
            where: { postId_metricDate: { postId: post.id, metricDate: postData.publishedAt } },
            create: { ...metricWithoutPostId, postId: post.id },
            update: metricWithoutPostId,
          });
        });

        const processed = i + 1;
        const progress = Math.round((processed / posts.length) * 100);
        await this.prisma.syncJob.update({
          where: { id: sync.id },
          data: { processedItems: processed, progress },
        });
        await job.updateProgress(progress);
      }

      await this.prisma.$transaction([
        this.prisma.syncJob.update({
          where: { id: sync.id },
          data: { status: 'SUCCESS', progress: 100, finishedAt: new Date() },
        }),
        this.prisma.platformAccount.update({
          where: { id: sync.platformAccountId },
          data: { lastSyncedAt: new Date() },
        }),
      ]);

      this.logger.log(`SyncJob ${sync.id} completed: ${posts.length} posts processed`);
      return { processed: posts.length };
    } catch (error) {
      await this.prisma.syncJob.update({
        where: { id: sync.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorCode: 'SYNC_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }
}
