import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kpi, Platform, PostMetric, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateKpiDto, UpdateKpiDto } from './dto';
import { KPI_METRICS, KpiMetric } from './kpi.constants';
import { KpiCalculatorService } from './kpi-calculator.service';

export type KpiPerformance = Kpi & {
  actual: number | null;
  achievementRate: number | null;
  status: string | null;
};

const SUM_METRICS = new Set<KpiMetric>([
  'views',
  'reach',
  'viewers',
  'reactions',
  'likes',
  'comments',
  'shares',
  'saves',
  'view3Seconds',
  'view1Minute',
  'totalWatchTimeSeconds',
  'newFollowers',
]);
const AVERAGE_METRICS = new Set<KpiMetric>([
  'averageWatchTimeSeconds',
  'completionRate',
  'newViewerRate',
  'returningViewerRate',
  'maleRate',
  'femaleRate',
]);

@Injectable()
export class KpisService {
  constructor(
    private prisma: PrismaService,
    private calculator: KpiCalculatorService,
  ) {}

  list(user: AuthUser, platform?: Platform) {
    return this.prisma.kpi.findMany({
      where: {
        ...(platform ? { platform } : {}),
        ...(user.role === Role.ADMIN ? {} : { createdBy: user.id }),
      },
      orderBy: { periodStart: 'desc' },
    });
  }

  create(dto: CreateKpiDto, user: AuthUser) {
    this.validateDates(dto.periodStart, dto.periodEnd);
    this.validateMetric(dto.metricName);
    return this.prisma.kpi.create({
      data: {
        ...dto,
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
        targetValue: new Prisma.Decimal(dto.targetValue),
        createdBy: user.id,
      },
    });
  }

  async get(id: string, user: AuthUser) {
    const row = await this.prisma.kpi.findFirst({
      where: { id, ...(user.role === Role.ADMIN ? {} : { createdBy: user.id }) },
    });
    if (!row) throw new NotFoundException('KPI_NOT_FOUND');
    return row;
  }

  async update(id: string, dto: UpdateKpiDto, user: AuthUser) {
    const current = await this.get(id, user);
    const start = dto.periodStart ?? current.periodStart.toISOString();
    const end = dto.periodEnd ?? current.periodEnd.toISOString();
    this.validateDates(start, end);
    if (dto.metricName !== undefined) this.validateMetric(dto.metricName);
    return this.prisma.kpi.update({
      where: { id },
      data: {
        ...dto,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
        targetValue:
          dto.targetValue !== undefined ? new Prisma.Decimal(dto.targetValue) : undefined,
      },
    });
  }

  async remove(id: string, user: AuthUser) {
    await this.get(id, user);
    await this.prisma.kpi.delete({ where: { id } });
    return { deleted: true };
  }

  async performance(
    user: AuthUser,
    platform?: Platform,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<KpiPerformance[]> {
    if (dateFrom && dateTo) this.validateDates(dateFrom, dateTo);
    const kpis = await this.list(user, platform);
    const visibleKpis = kpis.filter((kpi) => {
      const from = dateFrom ? new Date(dateFrom) : null;
      const to = dateTo ? this.endOfDay(new Date(dateTo)) : null;
      return (!from || kpi.periodEnd >= from) && (!to || kpi.periodStart <= to);
    });
    return Promise.all(visibleKpis.map((kpi) => this.calculate(kpi, user)));
  }

  private async calculate(kpi: Kpi, user: AuthUser): Promise<KpiPerformance> {
    const posts = await this.prisma.post.findMany({
      where: {
        platform: kpi.platform,
        publishedAt: {
          gte: kpi.periodStart,
          lte: this.endOfDay(kpi.periodEnd),
        },
        ...(user.role === Role.ADMIN ? {} : { platformAccount: { userId: user.id } }),
      },
      select: {
        metrics: {
          orderBy: { metricDate: 'desc' },
          take: 1,
        },
      },
    });

    const metricName = kpi.metricName as KpiMetric;
    let actual: number | null;
    if (metricName === 'posts') {
      actual = posts.length;
    } else {
      const metrics = posts.flatMap((post) => post.metrics);
      actual = this.actualFromMetrics(kpi.platform, metricName, metrics);
    }

    const achievementRate = this.calculator.achievement(actual, kpi.targetValue.toNumber());
    return {
      ...kpi,
      actual,
      achievementRate,
      status: this.calculator.status(achievementRate),
    };
  }

  private actualFromMetrics(
    platform: Platform,
    metricName: KpiMetric,
    metrics: PostMetric[],
  ): number | null {
    if (metricName === 'engagementRate') {
      const numeratorFields: (keyof PostMetric)[] =
        platform === Platform.FACEBOOK
          ? ['reactions', 'comments', 'shares']
          : ['likes', 'comments', 'shares', 'saves'];
      const denominatorField: keyof PostMetric = platform === Platform.FACEBOOK ? 'reach' : 'views';
      const denominator = this.sumValues(metrics, denominatorField);
      if (!denominator) return null;
      const numerator = numeratorFields.reduce(
        (total, field) => total + this.sumValues(metrics, field),
        0,
      );
      return Math.round((numerator / denominator) * 10_000) / 100;
    }

    if (SUM_METRICS.has(metricName)) {
      return this.sumValues(metrics, metricName as keyof PostMetric);
    }
    if (AVERAGE_METRICS.has(metricName)) {
      const values = metrics
        .map((metric) => this.toNumber(metric[metricName as keyof PostMetric]))
        .filter((value): value is number => value !== null);
      if (!values.length) return null;
      return (
        Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100
      );
    }
    return null;
  }

  private sumValues(metrics: PostMetric[], field: keyof PostMetric): number {
    return metrics.reduce((total, metric) => total + (this.toNumber(metric[field]) ?? 0), 0);
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    if (value instanceof Prisma.Decimal) return value.toNumber();
    return null;
  }

  private validateMetric(metricName: string): asserts metricName is KpiMetric {
    if (!KPI_METRICS.includes(metricName as KpiMetric)) {
      throw new BadRequestException(`metricName must be one of: ${KPI_METRICS.join(', ')}`);
    }
  }

  private validateDates(start: string, end: string) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      startDate > endDate
    ) {
      throw new BadRequestException('periodStart must be before or equal to periodEnd');
    }
  }

  private endOfDay(date: Date): Date {
    const result = new Date(date);
    result.setUTCHours(23, 59, 59, 999);
    return result;
  }
}
