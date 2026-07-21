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
    const row = await this.prisma.syncJob.create({
      data: {
        platformAccountId: account.id,
        jobType: account.platform === 'FACEBOOK' ? 'SYNC_FACEBOOK' : 'SYNC_TIKTOK',
        dateFrom: new Date(dto.dateFrom),
        dateTo: new Date(dto.dateTo),
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
