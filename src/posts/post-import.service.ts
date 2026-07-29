import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Platform, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateFacebookImportDto } from './import.dto';

@Injectable()
export class PostImportService {
  constructor(private readonly prisma: PrismaService) {}

  async createFacebookImport(dto: CreateFacebookImportDto, user: AuthUser) {
    const account = await this.prisma.platformAccount.findFirst({
      where: {
        id: dto.platformAccountId,
        platform: Platform.FACEBOOK,
        ...(user.role === Role.ADMIN ? {} : { userId: user.id }),
      },
    });
    if (!account) throw new ForbiddenException('FACEBOOK_ACCOUNT_NOT_FOUND');

    const dates = dto.rows.map((row) => new Date(row.publishedAt));
    if (dates.some((date) => Number.isNaN(date.getTime()))) {
      throw new BadRequestException('INVALID_IMPORT_DATE');
    }

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          userId: user.id,
          platformAccountId: account.id,
          platform: Platform.FACEBOOK,
          fileName: dto.fileName,
          status: 'PROCESSING',
          totalRows: dto.rows.length,
          dateFrom: this.dateOnly(new Date(Math.min(...dates.map((date) => date.getTime())))),
          dateTo: this.dateOnly(new Date(Math.max(...dates.map((date) => date.getTime())))),
        },
      });

      let importedRows = 0;
      for (const [index, row] of dto.rows.entries()) {
        const externalPostId = `import-${batch.id}-${index + 1}`;
        const publishedAt = new Date(row.publishedAt);
        await tx.post.create({
          data: {
            platformAccountId: account.id,
            externalPostId,
            platform: Platform.FACEBOOK,
            contentType: row.contentType,
            caption: row.caption?.trim() || null,
            postUrl: row.postUrl?.trim() || null,
            durationSeconds: row.durationSeconds == null ? null : Math.round(row.durationSeconds),
            publishedAt,
            importBatchId: batch.id,
            rawData: {
              source: 'FILE_IMPORT',
              fileName: dto.fileName,
              originalExternalPostId: row.externalPostId?.trim() || null,
            },
            metrics: {
              create: {
                metricDate: this.dateOnly(publishedAt),
                reach: this.bigInt(row.reach),
                views: this.bigInt(row.views),
                viewers: this.bigInt(row.viewers),
                reactions: this.bigInt(row.reactions ?? row.interactions),
                comments: this.bigInt(row.comments) ?? 0n,
                shares: this.bigInt(row.shares) ?? 0n,
                saves: this.bigInt(row.saves),
                view3Seconds: this.bigInt(row.view3Seconds),
                view1Minute: this.bigInt(row.view1Minute),
                totalWatchTimeSeconds: row.totalWatchTimeSeconds,
                averageWatchTimeSeconds: row.averageWatchTimeSeconds,
                rawData: {
                  source: 'FILE_IMPORT',
                  fileName: dto.fileName,
                  importedInteractions: row.interactions ?? null,
                },
              },
            },
          },
        });
        importedRows += 1;
      }

      return tx.importBatch.update({
        where: { id: batch.id },
        data: { status: 'COMPLETED', importedRows, skippedRows: 0 },
        include: {
          platformAccount: { select: { id: true, accountName: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });
    });
  }

  list(user: AuthUser) {
    return this.prisma.importBatch.findMany({
      where: user.role === Role.ADMIN ? {} : { userId: user.id },
      include: {
        platformAccount: { select: { id: true, accountName: true } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(id: string, user: AuthUser) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id, ...(user.role === Role.ADMIN ? {} : { userId: user.id }) },
    });
    if (!batch) throw new NotFoundException('IMPORT_BATCH_NOT_FOUND');

    const deletedPosts = await this.prisma.$transaction(async (tx) => {
      const result = await tx.post.deleteMany({ where: { importBatchId: batch.id } });
      await tx.importBatch.delete({ where: { id: batch.id } });
      return result.count;
    });
    return { deleted: true, deletedPosts };
  }

  private dateOnly(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  private bigInt(value: number | undefined): bigint | null {
    return value == null ? null : BigInt(Math.round(value));
  }
}
