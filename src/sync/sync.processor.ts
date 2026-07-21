import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { FakeSocialProvider } from './fake-social.provider';

@Processor('social-sync', { concurrency: 4 })
export class SyncProcessor extends WorkerHost {
  constructor(private prisma: PrismaService, private provider: FakeSocialProvider) { super(); }

  async process(job: Job<{ syncJobId: string }>): Promise<{ processed: number }> {
    const sync = await this.prisma.syncJob.update({
      where: { id: job.data.syncJobId },
      data: { status: 'RUNNING', startedAt: new Date(), progress: 1 },
      include: { platformAccount: true },
    });
    try {
      const posts = await this.provider.getPosts(sync.platformAccount.externalAccountId, sync.dateFrom, sync.dateTo);
      await this.prisma.syncJob.update({ where: { id: sync.id }, data: { totalItems: posts.length } });
      for (let i = 0; i < posts.length; i++) {
        const { metric, ...postData } = posts[i];
        const metricData = { ...metric, rawData: metric.rawData as Prisma.InputJsonValue, engagementRate: metric.engagementRate === null ? null : new Prisma.Decimal(metric.engagementRate) };
        await this.prisma.$transaction(async (tx) => {
          const post = await tx.post.upsert({
            where: { platformAccountId_externalPostId: { platformAccountId: sync.platformAccountId, externalPostId: postData.externalPostId } },
            create: { ...postData, rawData: postData.rawData as Prisma.InputJsonValue, platformAccountId: sync.platformAccountId },
            update: { caption: postData.caption, rawData: postData.rawData as Prisma.InputJsonValue, publishedAt: postData.publishedAt },
          });
          await tx.postMetric.upsert({
            where: { postId_metricDate: { postId: post.id, metricDate: postData.publishedAt } },
            create: { ...metricData, postId: post.id, metricDate: postData.publishedAt },
            update: metricData,
          });
        });
        const processed = i + 1;
        const progress = Math.round((processed / posts.length) * 100);
        await this.prisma.syncJob.update({ where: { id: sync.id }, data: { processedItems: processed, progress } });
        await job.updateProgress(progress);
      }
      await this.prisma.$transaction([
        this.prisma.syncJob.update({ where: { id: sync.id }, data: { status: 'SUCCESS', progress: 100, finishedAt: new Date() } }),
        this.prisma.platformAccount.update({ where: { id: sync.platformAccountId }, data: { lastSyncedAt: new Date() } }),
      ]);
      return { processed: posts.length };
    } catch (error) {
      await this.prisma.syncJob.update({ where: { id: sync.id }, data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'SYNC_FAILED', errorMessage: error instanceof Error ? error.message : 'Unknown error' } });
      throw error;
    }
  }
}
