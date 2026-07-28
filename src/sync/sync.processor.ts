import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import {
  TikTokAnalyticsService,
  TikTokAnalyticsMetric,
} from '../platform-accounts/tiktok-analytics.service';
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
    private tiktokAnalytics: TikTokAnalyticsService,
  ) {
    super();
  }

  async process(job: Job<{ syncJobId: string }>): Promise<{ processed: number }> {
    const sync = await this.prisma.syncJob.update({
      where: { id: job.data.syncJobId },
      data: { status: 'RUNNING', startedAt: new Date(), progress: 1 },
      include: { platformAccount: true },
    });
    await this.prisma.syncLog.create({
      data: {
        syncJobId: sync.id,
        level: 'INFO',
        message: 'Bắt đầu tạo lượt đồng bộ',
        context: {
          platform: sync.platformAccount.platform,
          dateFrom: sync.dateFrom.toISOString(),
          dateTo: sync.dateTo.toISOString(),
        },
      },
    });

    try {
      // ─── Chọn provider: real (Facebook/TikTok API) hoặc fake (dev) ─────────
      const mode = this.config.get<string>('SOCIAL_PROVIDER_MODE', 'fake');
      let posts;

      if (mode === 'real') {
        try {
          const { provider, externalAccountId, accessToken } =
            await this.providerFactory.getForAccount(sync.platformAccountId);

          posts = await provider.getPosts(
            externalAccountId,
            sync.dateFrom,
            sync.dateTo,
            accessToken,
          );
        } catch (error) {
          if (sync.platformAccount.platform !== 'TIKTOK') throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `TikTok API provider unavailable, falling back to Studio scrape: ${message}`,
          );
          await this.prisma.syncLog.create({
            data: {
              syncJobId: sync.id,
              level: 'WARN',
              message: 'TikTok API chưa khả dụng, chuyển sang scan TikTok Studio',
              context: { error: message },
            },
          });
          await this.logProgress(sync.id, 'Đang chuẩn bị scan TikTok Studio', 5);
          posts = await this.tiktokAnalytics.collectPosts(
            sync.platformAccountId,
            sync.dateFrom,
            sync.dateTo,
            (event) =>
              this.logProgress(
                sync.id,
                event.message,
                event.progress,
                event.processedItems,
                event.totalItems,
                event.context,
              ),
          );
        }
      } else {
        posts = await this.fakeProvider.getPosts(
          sync.platformAccount.externalAccountId,
          sync.dateFrom,
          sync.dateTo,
        );
      }

      await this.prisma.syncJob.update({
        where: { id: sync.id },
        data: { totalItems: posts.length, progress: Math.max(sync.progress, 33) },
      });
      await this.logProgress(
        sync.id,
        `Đã lấy danh sách ${posts.length} bài, chuẩn bị đọc analytics`,
        33,
        0,
        posts.length,
      );

      let analytics = new Map<string, TikTokAnalyticsMetric>();
      if (sync.platformAccount.platform === 'TIKTOK') {
        try {
          await this.logProgress(
            sync.id,
            'Bắt đầu vào từng trang phân tích TikTok Studio để đọc 3 tab',
            35,
            0,
            posts.length,
          );
          analytics = await this.tiktokAnalytics.collect(
            sync.platformAccountId,
            posts.map((post) => post.externalPostId),
            (event) =>
              this.logProgress(
                sync.id,
                event.message,
                event.progress,
                event.processedItems,
                event.totalItems,
                event.context,
              ),
          );
          await this.prisma.syncLog.create({
            data: {
              syncJobId: sync.id,
              level: 'INFO',
              message: 'Đã thu thập analytics từ TikTok Studio',
              context: {
                requestedVideos: posts.length,
                collectedVideos: analytics.size,
                collectedVideoIds: [...analytics.keys()],
              },
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`TikTok Analytics enrichment skipped: ${message}`);
          await this.prisma.syncLog.create({
            data: {
              syncJobId: sync.id,
              level: 'WARN',
              message: 'Bỏ qua bước bổ sung analytics TikTok Studio',
              context: { error: message },
            },
          });
        }
      }

      const socialAccount = await this.prisma.socialAccount.findUnique({
        where: {
          platform_externalAccountId_userId: {
            platform: sync.platformAccount.platform,
            externalAccountId: sync.platformAccount.externalAccountId,
            userId: sync.platformAccount.userId,
          },
        },
        select: { id: true },
      });

      for (let i = 0; i < posts.length; i++) {
        const { metric, ...postData } = posts[i];
        const analyticsMetric = analytics.get(postData.externalPostId);
        const metricRawData = {
          ...((metric.rawData as Record<string, unknown>) ?? {}),
          ...(analyticsMetric
            ? {
                studioAnalytics: {
                  trafficSources: analyticsMetric.trafficSources,
                  ageGroups: analyticsMetric.ageGroups,
                  locations: analyticsMetric.locations,
                  commentKeywords: analyticsMetric.commentKeywords,
                  otherGenderRate: analyticsMetric.otherGenderRate,
                  followerRate: analyticsMetric.followerRate,
                  nonFollowerRate: analyticsMetric.nonFollowerRate,
                  rawTabs: analyticsMetric.rawTabs,
                },
              }
            : {}),
        };

        // Lấy extended fields từ rawData (TikTok inject ở đây)
        const extended = (metric.rawData as Record<string, unknown>)['_extended'] as
          Record<string, unknown> | undefined;

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
          rawData: metricRawData as Prisma.InputJsonValue,
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
                newFollowers: this.toBigIntOrNull(extended.newFollowers),
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
          ...(analyticsMetric
            ? {
                views: analyticsMetric.views != null ? BigInt(analyticsMetric.views) : metric.views,
                viewers:
                  analyticsMetric.viewers != null
                    ? BigInt(analyticsMetric.viewers)
                    : metric.viewers,
                likes: analyticsMetric.likes != null ? BigInt(analyticsMetric.likes) : metric.likes,
                comments:
                  analyticsMetric.comments != null
                    ? BigInt(analyticsMetric.comments)
                    : metric.comments,
                shares:
                  analyticsMetric.shares != null ? BigInt(analyticsMetric.shares) : metric.shares,
                saves: analyticsMetric.saves != null ? BigInt(analyticsMetric.saves) : metric.saves,
                totalWatchTimeSeconds:
                  analyticsMetric.totalWatchTimeSeconds != null
                    ? new Prisma.Decimal(analyticsMetric.totalWatchTimeSeconds)
                    : undefined,
                averageWatchTimeSeconds:
                  analyticsMetric.averageWatchTimeSeconds != null
                    ? new Prisma.Decimal(analyticsMetric.averageWatchTimeSeconds)
                    : undefined,
                completionRate:
                  analyticsMetric.completionRate != null
                    ? new Prisma.Decimal(analyticsMetric.completionRate)
                    : undefined,
                newFollowers:
                  analyticsMetric.newFollowers != null
                    ? BigInt(analyticsMetric.newFollowers)
                    : undefined,
                trafficSource: analyticsMetric.trafficSource ?? undefined,
                newViewerRate:
                  analyticsMetric.newViewerRate != null
                    ? new Prisma.Decimal(analyticsMetric.newViewerRate)
                    : undefined,
                returningViewerRate:
                  analyticsMetric.returningViewerRate != null
                    ? new Prisma.Decimal(analyticsMetric.returningViewerRate)
                    : undefined,
                maleRate:
                  analyticsMetric.maleRate != null
                    ? new Prisma.Decimal(analyticsMetric.maleRate)
                    : undefined,
                femaleRate:
                  analyticsMetric.femaleRate != null
                    ? new Prisma.Decimal(analyticsMetric.femaleRate)
                    : undefined,
                mainAgeGroup: analyticsMetric.mainAgeGroup ?? undefined,
                mainLocation: analyticsMetric.mainLocation ?? undefined,
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

          const { postId: _ignored, ...metricWithoutPostId } = metricData as typeof metricData & {
            postId: string;
          };

          await tx.postMetric.upsert({
            where: { postId_metricDate: { postId: post.id, metricDate: postData.publishedAt } },
            create: { ...metricWithoutPostId, postId: post.id },
            update: metricWithoutPostId,
          });

          // Dual-write to the new platform-neutral schema while the existing
          // frontend continues reading the legacy tables.
          if (socialAccount) {
            const socialPost = await tx.socialPost.upsert({
              where: {
                socialAccountId_externalPostId: {
                  socialAccountId: socialAccount.id,
                  externalPostId: postData.externalPostId,
                },
              },
              create: {
                id: post.id,
                socialAccountId: socialAccount.id,
                ...postData,
                rawData: postData.rawData as Prisma.InputJsonValue,
              },
              update: {
                caption: postData.caption,
                rawData: postData.rawData as Prisma.InputJsonValue,
                publishedAt: postData.publishedAt,
              },
            });
            await tx.socialPostMetricSnapshot.upsert({
              where: {
                postId_metricDate: {
                  postId: socialPost.id,
                  metricDate: postData.publishedAt,
                },
              },
              create: {
                postId: socialPost.id,
                metricDate: postData.publishedAt,
                views: metricData.views as bigint | null,
                reach: metric.reach,
                likes: metricData.likes as bigint | null,
                comments: metricData.comments as bigint | null,
                shares: metricData.shares as bigint | null,
                saves: metricData.saves as bigint | null,
                reactions: metric.reactions,
                engagementRate:
                  metric.engagementRate === null ? null : new Prisma.Decimal(metric.engagementRate),
                rawData: metricRawData as Prisma.InputJsonValue,
              },
              update: {
                views: metricData.views as bigint | null,
                reach: metric.reach,
                likes: metricData.likes as bigint | null,
                comments: metricData.comments as bigint | null,
                shares: metricData.shares as bigint | null,
                saves: metricData.saves as bigint | null,
                reactions: metric.reactions,
                engagementRate:
                  metric.engagementRate === null ? null : new Prisma.Decimal(metric.engagementRate),
                rawData: metricRawData as Prisma.InputJsonValue,
              },
            });
            if (analyticsMetric) {
              await tx.socialPostAnalyticsSnapshot.create({
                data: {
                  postId: socialPost.id,
                  viewers: analyticsMetric.viewers != null ? BigInt(analyticsMetric.viewers) : null,
                  saves: analyticsMetric.saves != null ? BigInt(analyticsMetric.saves) : null,
                  totalWatchTimeSeconds:
                    analyticsMetric.totalWatchTimeSeconds != null
                      ? new Prisma.Decimal(analyticsMetric.totalWatchTimeSeconds)
                      : null,
                  averageWatchTimeSeconds:
                    analyticsMetric.averageWatchTimeSeconds != null
                      ? new Prisma.Decimal(analyticsMetric.averageWatchTimeSeconds)
                      : null,
                  completionRate:
                    analyticsMetric.completionRate != null
                      ? new Prisma.Decimal(analyticsMetric.completionRate)
                      : null,
                  newFollowers:
                    analyticsMetric.newFollowers != null
                      ? BigInt(analyticsMetric.newFollowers)
                      : null,
                  maleRate:
                    analyticsMetric.maleRate != null
                      ? new Prisma.Decimal(analyticsMetric.maleRate)
                      : null,
                  femaleRate:
                    analyticsMetric.femaleRate != null
                      ? new Prisma.Decimal(analyticsMetric.femaleRate)
                      : null,
                  mainAgeGroup: analyticsMetric.mainAgeGroup ?? null,
                  mainLocation: analyticsMetric.mainLocation ?? null,
                  trafficSource: analyticsMetric.trafficSource ?? null,
                  collectionMethod: 'PLAYWRIGHT',
                  collectionStatus: 'PARTIAL',
                  rawPayload: metricRawData as Prisma.InputJsonValue,
                },
              });
            }
          }
        });

        const processed = i + 1;
        const progress = posts.length
          ? Math.min(99, Math.round(75 + (processed / posts.length) * 24))
          : 99;
        await this.prisma.syncJob.update({
          where: { id: sync.id },
          data: { processedItems: processed, progress },
        });
        if (processed === 1 || processed === posts.length || processed % 5 === 0) {
          await this.prisma.syncLog.create({
            data: {
              syncJobId: sync.id,
              level: 'INFO',
              message: `Đã lưu ${processed}/${posts.length} bài vào hệ thống`,
              context: { processedItems: processed, totalItems: posts.length, progress },
            },
          });
        }
        await job.updateProgress(progress);
      }

      await this.prisma.$transaction([
        this.prisma.syncJob.update({
          where: { id: sync.id },
          data: { status: 'SUCCESS', progress: 100, finishedAt: new Date() },
        }),
        this.prisma.syncLog.create({
          data: {
            syncJobId: sync.id,
            level: 'INFO',
            message: 'Hoàn tất đồng bộ',
            context: {
              processedItems: posts.length,
              tiktokAnalyticsItems: analytics.size,
            },
          },
        }),
        this.prisma.platformAccount.update({
          where: { id: sync.platformAccountId },
          data: { lastSyncedAt: new Date() },
        }),
      ]);

      this.logger.log(`SyncJob ${sync.id} completed: ${posts.length} posts processed`);
      return { processed: posts.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.prisma.$transaction([
        this.prisma.syncJob.update({
          where: { id: sync.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorCode: 'SYNC_FAILED',
            errorMessage: message,
          },
        }),
        this.prisma.syncLog.create({
          data: {
            syncJobId: sync.id,
            level: 'ERROR',
            message: 'Đồng bộ thất bại',
            context: { error: message },
          },
        }),
      ]);
      throw error;
    }
  }

  private toBigIntOrNull(value: unknown): bigint | null {
    if (value == null) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) return BigInt(value);
    return null;
  }

  private async logProgress(
    syncJobId: string,
    message: string,
    progress?: number,
    processedItems?: number,
    totalItems?: number,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const data: Prisma.SyncJobUpdateInput = {};
    if (progress != null) data.progress = Math.max(0, Math.min(99, progress));
    if (processedItems != null) data.processedItems = processedItems;
    if (totalItems != null) data.totalItems = totalItems;

    const createLog = this.prisma.syncLog.create({
      data: {
        syncJobId,
        level: 'INFO',
        message,
        context: {
          ...(context ?? {}),
          ...(progress != null ? { progress } : {}),
          ...(processedItems != null ? { processedItems } : {}),
          ...(totalItems != null ? { totalItems } : {}),
        },
      },
    });
    if (!Object.keys(data).length) {
      await createLog;
      return;
    }
    await this.prisma.$transaction([
      this.prisma.syncJob.update({ where: { id: syncJobId }, data }),
      createLog,
    ]);
  }
}
