import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Platform, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateKpiDto, UpdateKpiDto } from './dto';
import { KpiCalculatorService } from './kpi-calculator.service';

@Injectable()
export class KpisService {
  constructor(private prisma: PrismaService, private calculator: KpiCalculatorService) { }

  list(user: AuthUser, platform?: Platform) {
    return this.prisma.kpi.findMany({
      where: { ...(platform ? { platform } : {}), ...(user.role === Role.ADMIN ? {} : { createdBy: user.id }) },
      orderBy: { periodStart: 'desc' },
    });
  }

  create(dto: CreateKpiDto, user: AuthUser) {
    this.validateDates(dto.periodStart, dto.periodEnd);
    return this.prisma.kpi.create({ data: { ...dto, periodStart: new Date(dto.periodStart), periodEnd: new Date(dto.periodEnd), targetValue: new Prisma.Decimal(dto.targetValue), createdBy: user.id } });
  }

  async get(id: string, user: AuthUser) {
    const row = await this.prisma.kpi.findFirst({ where: { id, ...(user.role === Role.ADMIN ? {} : { createdBy: user.id }) } });
    if (!row) throw new NotFoundException('KPI_NOT_FOUND');
    return row;
  }

  async update(id: string, dto: UpdateKpiDto, user: AuthUser) {
    const current = await this.get(id, user);
    const start = dto.periodStart ?? current.periodStart.toISOString();
    const end = dto.periodEnd ?? current.periodEnd.toISOString();
    this.validateDates(start, end);
    return this.prisma.kpi.update({ where: { id }, data: { ...dto, periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined, periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined, targetValue: dto.targetValue ? new Prisma.Decimal(dto.targetValue) : undefined } });
  }

  async remove(id: string, user: AuthUser) { await this.get(id, user); await this.prisma.kpi.delete({ where: { id } }); return { deleted: true }; }

  async performance(user: AuthUser, platform?: Platform) {
    const kpis = await this.list(user, platform);
    return Promise.all(kpis.map(async (kpi) => {
      const accountFilter = user.role === Role.ADMIN ? {} : { platformAccount: { userId: user.id } };
      const metricFilter = { post: { platform: kpi.platform, publishedAt: { gte: kpi.periodStart, lte: kpi.periodEnd }, ...accountFilter } };
      let actual: number | null = null;
      if (kpi.metricName === 'posts') actual = await this.prisma.post.count({ where: { platform: kpi.platform, publishedAt: { gte: kpi.periodStart, lte: kpi.periodEnd }, ...accountFilter } });
      else if (['views', 'reach', 'reactions', 'likes', 'comments', 'shares', 'saves', 'newFollowers'].includes(kpi.metricName)) {
        const aggregate = await this.prisma.postMetric.aggregate({ where: metricFilter, _sum: { [kpi.metricName]: true } as Prisma.PostMetricSumAggregateInputType });
        const value = aggregate._sum[kpi.metricName as keyof typeof aggregate._sum];
        actual = value === null || value === undefined ? null : Number(value);
      } else if (kpi.metricName === 'engagementRate') {
        const aggregate = await this.prisma.postMetric.aggregate({ where: metricFilter, _avg: { engagementRate: true } });
        actual = aggregate._avg.engagementRate?.toNumber() ?? null;
      }
      const target = kpi.targetValue.toNumber();
      const achievementRate = this.calculator.achievement(actual, target);
      return { ...kpi, actual, achievementRate, status: this.calculator.status(achievementRate) };
    }));
  }

  private validateDates(start: string, end: string) { if (new Date(start) > new Date(end)) throw new BadRequestException('periodStart must be before or equal to periodEnd'); }
}
