import { ConflictException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { PlatformAccountsService } from '../platform-accounts/platform-accounts.service';
import { CreateSyncDto } from './dto';
@Injectable()
export class SyncService {
  constructor(
    private prisma: PrismaService,
    private accounts: PlatformAccountsService,
    @InjectQueue('social-sync') private queue: Queue,
  ) {}
  async create(dto: CreateSyncDto, user: AuthUser) {
    const account = await this.accounts.assertOwned(dto.platformAccountId, user);
    if (account.connectionStatus !== 'CONNECTED')
      throw new ConflictException('PLATFORM_TOKEN_EXPIRED');
    const active = await this.prisma.syncJob.findFirst({
      where: { platformAccountId: account.id, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (active) throw new ConflictException('SYNC_ALREADY_RUNNING');
    const dateFrom = new Date(dto.dateFrom);
    const dateTo = new Date(dto.dateTo);
    // Inputs from <input type="date"> are parsed at 00:00 UTC. Include the
    // entire selected end date so posts published later that day are not lost.
    dateTo.setUTCHours(23, 59, 59, 999);
    const row = await this.prisma.syncJob.create({
      data: {
        platformAccountId: account.id,
        jobType: account.platform === 'FACEBOOK' ? 'SYNC_FACEBOOK' : 'SYNC_TIKTOK',
        dateFrom,
        dateTo,
        metadata: { forceRefresh: dto.forceRefresh },
      },
    });
    await this.queue.add(
      row.jobType,
      { syncJobId: row.id },
      {
        jobId: row.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
      },
    );
    return { jobId: row.id, status: row.status };
  }
  async list(user: AuthUser) {
    return this.prisma.syncJob.findMany({
      where: user.role === 'ADMIN' ? {} : { platformAccount: { userId: user.id } },
      orderBy: { createdAt: 'desc' },
    });
  }
  async get(id: string, user: AuthUser) {
    const row = await this.prisma.syncJob.findFirst({
      where: { id, ...(user.role === 'ADMIN' ? {} : { platformAccount: { userId: user.id } }) },
    });
    return row;
  }
  async result(id: string, user: AuthUser) {
    const job = await this.get(id, user);
    if (!job) return null;

    const posts = await this.prisma.post.findMany({
      where: {
        platformAccountId: job.platformAccountId,
        publishedAt: { gte: job.dateFrom, lte: job.dateTo },
      },
      select: {
        id: true,
        externalPostId: true,
        platform: true,
        contentType: true,
        caption: true,
        postUrl: true,
        thumbnailUrl: true,
        durationSeconds: true,
        publishedAt: true,
        metrics: {
          orderBy: { metricDate: 'desc' },
          take: 1,
          select: {
            views: true,
            likes: true,
            comments: true,
            shares: true,
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
    });

    return {
      jobId: job.id,
      status: job.status,
      totalItems: job.totalItems,
      processedItems: job.processedItems,
      videos: posts.map(({ metrics, ...post }) => ({
        ...post,
        views: metrics[0]?.views ?? null,
        likes: metrics[0]?.likes ?? null,
        comments: metrics[0]?.comments ?? null,
        shares: metrics[0]?.shares ?? null,
      })),
    };
  }
  async cancel(id: string, user: AuthUser) {
    const row = await this.get(id, user);
    if (!row) return null;
    await this.queue.remove(id);
    return this.prisma.syncJob.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }
}
