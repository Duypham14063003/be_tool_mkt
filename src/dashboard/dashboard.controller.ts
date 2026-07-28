import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Platform, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { KpisService } from '../kpis/kpis.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('dashboard')
export class DashboardController {
  constructor(
    private prisma: PrismaService,
    private kpis: KpisService,
  ) {}

  @Get('summary')
  async summary(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    const posts = await this.latestMetrics(user, platform, from, to);
    const metrics = posts.flatMap((post) => post.metrics);
    const sum = (field: keyof (typeof metrics)[number]) =>
      metrics.reduce((total, metric) => {
        const value = metric[field];
        return total + (typeof value === 'bigint' ? Number(value) : 0);
      }, 0);

    const denominator = posts.reduce((total, post) => {
      const metric = post.metrics[0];
      if (!metric) return total;
      return (
        total +
        Number(post.platform === Platform.FACEBOOK ? (metric.reach ?? 0) : (metric.views ?? 0))
      );
    }, 0);
    const engagements =
      sum('reactions') + sum('likes') + sum('comments') + sum('shares') + sum('saves');
    const engagementRate = denominator
      ? Math.round((engagements / denominator) * 10_000) / 100
      : null;

    const performance = await this.kpis.performance(user, platform, from, to);
    const achievementRates = performance
      .map((kpi) => kpi.achievementRate)
      .filter((rate): rate is number => rate !== null);
    const kpiAchievementRate = achievementRates.length
      ? Math.round(
          (achievementRates.reduce((total, rate) => total + rate, 0) / achievementRates.length) *
            100,
        ) / 100
      : null;

    return {
      totalPosts: posts.length,
      totalViews: sum('views'),
      totalReach: sum('reach'),
      totalReactions: sum('reactions'),
      totalLikes: sum('likes'),
      totalComments: sum('comments'),
      totalShares: sum('shares'),
      totalSaves: sum('saves'),
      totalNewFollowers: sum('newFollowers'),
      engagementRate,
      kpiAchievementRate,
      kpiTotal: performance.length,
      kpiMet: performance.filter(
        (kpi) => kpi.achievementRate !== null && kpi.achievementRate >= 100,
      ).length,
    };
  }

  @Get('timeline')
  async timeline(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    const posts = await this.latestMetrics(user, platform, from, to);
    const grouped = new Map<
      string,
      {
        metricDate: string;
        views: number;
        reach: number;
        engagements: number;
        engagementBase: number;
      }
    >();
    for (const post of posts) {
      const metric = post.metrics[0];
      if (!metric) continue;
      const date = metric.metricDate.toISOString().slice(0, 10);
      const row = grouped.get(date) ?? {
        metricDate: date,
        views: 0,
        reach: 0,
        engagements: 0,
        engagementBase: 0,
      };
      row.views += Number(metric.views ?? 0);
      row.reach += Number(metric.reach ?? 0);
      row.engagementBase +=
        post.platform === Platform.FACEBOOK ? Number(metric.reach ?? 0) : Number(metric.views ?? 0);
      row.engagements +=
        Number(metric.reactions ?? metric.likes ?? 0) +
        Number(metric.comments ?? 0) +
        Number(metric.shares ?? 0) +
        Number(metric.saves ?? 0);
      grouped.set(date, row);
    }
    return [...grouped.values()]
      .sort((a, b) => a.metricDate.localeCompare(b.metricDate))
      .map(({ engagementBase, ...row }) => ({
        ...row,
        engagementRate: engagementBase
          ? Math.round((row.engagements / engagementBase) * 10_000) / 100
          : null,
      }));
  }

  @Get('platform-comparison')
  comparison(
    @CurrentUser() user: AuthUser,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    return Promise.all(
      [Platform.FACEBOOK, Platform.TIKTOK].map(async (platform) => ({
        platform,
        ...(await this.summary(user, platform, from, to)),
      })),
    );
  }

  @Get('top-posts')
  async top(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    const posts = await this.latestMetrics(user, platform, from, to);
    return posts
      .sort((a, b) => Number(b.metrics[0]?.views ?? 0) - Number(a.metrics[0]?.views ?? 0))
      .slice(0, 10);
  }

  @Get('kpi-performance')
  kpi(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('dateFrom') from?: string,
    @Query('dateTo') to?: string,
  ) {
    return this.kpis.performance(user, platform, from, to);
  }

  @Get('low-performing-posts')
  async low(
    @CurrentUser() user: AuthUser,
    @Query('platform') platform?: Platform,
    @Query('threshold') threshold = '1',
  ) {
    const limit = Number(threshold);
    const posts = await this.latestMetrics(user, platform);
    return posts
      .filter((post) => {
        const rate = post.metrics[0]?.engagementRate;
        return rate !== null && rate !== undefined && rate.toNumber() < limit;
      })
      .sort(
        (a, b) =>
          (a.metrics[0]?.engagementRate?.toNumber() ?? 0) -
          (b.metrics[0]?.engagementRate?.toNumber() ?? 0),
      )
      .slice(0, 10);
  }

  private latestMetrics(user: AuthUser, platform?: Platform, dateFrom?: string, dateTo?: string) {
    const publishedAt: Prisma.DateTimeFilter | undefined =
      dateFrom || dateTo
        ? {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: this.endOfDay(new Date(dateTo)) } : {}),
          }
        : undefined;
    return this.prisma.post.findMany({
      where: {
        ...(platform ? { platform } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(user.role === Role.ADMIN ? {} : { platformAccount: { userId: user.id } }),
      },
      include: {
        metrics: {
          orderBy: { metricDate: 'desc' },
          take: 1,
        },
      },
    });
  }

  private endOfDay(date: Date): Date {
    const result = new Date(date);
    result.setUTCHours(23, 59, 59, 999);
    return result;
  }
}
