import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Platform, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('dashboard')
export class DashboardController {
  constructor(private prisma: PrismaService) {}
  private where(
    user: AuthUser,
    platform?: Platform,
    dateFrom?: string,
    dateTo?: string,
  ): Prisma.PostMetricWhereInput {
    return {
      ...(user.role === Role.ADMIN
        ? {}
        : {
            post: {
              platformAccount: { userId: user.id },
              ...(platform ? { platform } : {}),
              ...(dateFrom || dateTo
                ? {
                    publishedAt: {
                      ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                      ...(dateTo ? { lte: new Date(dateTo) } : {}),
                    },
                  }
                : {}),
            },
          }),
      ...(user.role === Role.ADMIN && platform ? { post: { platform } } : {}),
    };
  }
  @Get('channels') async channels(@CurrentUser() user: AuthUser) {
    const accounts = await this.prisma.platformAccount.findMany({
      where: user.role === Role.ADMIN ? {} : { userId: user.id },
      select: {
        id: true,
        platform: true,
        accountName: true,
        externalAccountId: true,
        connectionStatus: true,
        lastSyncedAt: true,
        posts: {
          select: {
            metrics: {
              orderBy: { metricDate: 'desc' },
              take: 1,
              select: {
                views: true,
                reach: true,
                reactions: true,
                comments: true,
                shares: true,
                newFollowers: true,
                rawData: true,
              },
            },
          },
        },
        syncJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, createdAt: true, updatedAt: true },
        },
      },
      orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }],
    });

    const channelCounts = {
      facebook: accounts.filter((account) => account.platform === Platform.FACEBOOK).length,
      tiktok: accounts.filter((account) => account.platform === Platform.TIKTOK).length,
    };
    const accountStats = accounts.map(({ posts, syncJobs, ...account }) => {
      const totals = posts.reduce(
        (result, post) => {
          const metric = post.metrics[0];
          result.views += metric?.views ?? 0n;
          result.reach += metric?.reach ?? 0n;
          result.followers += metric?.newFollowers ?? 0n;
          const importedInteractions =
            metric?.rawData &&
            typeof metric.rawData === 'object' &&
            !Array.isArray(metric.rawData) &&
            'importedInteractions' in metric.rawData
              ? Number(metric.rawData.importedInteractions)
              : null;
          result.interactions += Number.isFinite(importedInteractions)
            ? BigInt(Math.round(importedInteractions!))
            : (metric?.reactions ?? 0n) + (metric?.comments ?? 0n) + (metric?.shares ?? 0n);
          return result;
        },
        { views: 0n, reach: 0n, followers: 0n, interactions: 0n },
      );
      const latestJob = syncJobs[0];
      return {
        ...account,
        totalViews: totals.views,
        totalReach: totals.reach,
        totalFollowers: totals.followers,
        totalInteractions: totals.interactions,
        lastSyncAt: account.lastSyncedAt ?? latestJob?.updatedAt ?? null,
        lastSyncStatus: latestJob?.status ?? null,
      };
    });

    return {
      channelCounts,
      totalChannels: accounts.length,
      totalViews: accountStats.reduce((sum, account) => sum + account.totalViews, 0n),
      totalFollowers: accountStats.reduce((sum, account) => sum + account.totalFollowers, 0n),
      accounts: accountStats,
    };
  }
  @Get('summary') async summary(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    const where = this.where(user, platform, from, to);
    const [totalPosts, a] = await Promise.all([
      this.prisma.post.count({
        where: {
          ...(platform ? { platform } : {}),
          ...(user.role === Role.ADMIN ? {} : { platformAccount: { userId: user.id } }),
          ...(from || to
            ? {
                publishedAt: {
                  ...(from ? { gte: new Date(from) } : {}),
                  ...(to ? { lte: new Date(to) } : {}),
                },
              }
            : {}),
        },
      }),
      this.prisma.postMetric.aggregate({
        where,
        _sum: {
          views: true,
          reach: true,
          reactions: true,
          comments: true,
          shares: true,
          saves: true,
          newFollowers: true,
        },
        _avg: { engagementRate: true },
      }),
    ]);
    return {
      totalPosts,
      totalViews: a._sum.views,
      totalReach: a._sum.reach,
      totalReactions: a._sum.reactions,
      totalComments: a._sum.comments,
      totalShares: a._sum.shares,
      totalSaves: a._sum.saves,
      totalNewFollowers: a._sum.newFollowers,
      engagementRate: a._avg.engagementRate,
      kpiAchievementRate: null,
    };
  }
  @Get('timeline') async timeline(@CurrentUser() u: AuthUser, @Query('platform') p?: Platform) {
    const rows = await this.prisma.postMetric.findMany({
      where: this.where(u, p),
      select: { metricDate: true, views: true, reach: true, engagementRate: true },
      orderBy: { metricDate: 'asc' },
    });
    return rows;
  }
  @Get('platform-comparison') async comparison(@CurrentUser() u: AuthUser) {
    return Promise.all(
      [Platform.FACEBOOK, Platform.TIKTOK].map(async (platform) => ({
        platform,
        ...(await this.prisma.postMetric.aggregate({
          where: this.where(u, platform),
          _sum: { views: true, reach: true, likes: true, comments: true, shares: true },
          _avg: { engagementRate: true },
        })),
      })),
    );
  }
  @Get('top-posts') top(@CurrentUser() u: AuthUser) {
    return this.prisma.post.findMany({
      where: u.role === Role.ADMIN ? {} : { platformAccount: { userId: u.id } },
      include: { metrics: { orderBy: { views: 'desc' }, take: 1 } },
      take: 10,
      orderBy: { publishedAt: 'desc' },
    });
  }
  @Get('kpi-performance') async kpi() {
    return { message: 'Use GET /api/kpis/performance' };
  }
  @Get('low-performing-posts') low(@CurrentUser() u: AuthUser) {
    return this.prisma.post.findMany({
      where: u.role === Role.ADMIN ? {} : { platformAccount: { userId: u.id } },
      include: { metrics: { where: { engagementRate: { lt: 1 } }, take: 1 } },
      take: 10,
    });
  }
}
