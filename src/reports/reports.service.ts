import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Role } from '@prisma/client';
import { Queue } from 'bullmq';
import { existsSync } from 'fs';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateReportDto } from './dto';
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, @InjectQueue('report-generation') private queue: Queue) {}
  async create(dto: CreateReportDto, user: AuthUser) { if (new Date(dto.dateFrom) > new Date(dto.dateTo)) throw new BadRequestException('dateFrom must be before dateTo'); const report = await this.prisma.report.create({ data: { requestedBy: user.id, platform: dto.platform, dateFrom: new Date(dto.dateFrom), dateTo: new Date(dto.dateTo), format: dto.format } }); await this.queue.add('GENERATE_REPORT', { reportId: report.id }, { jobId: report.id, attempts: 3, backoff: { type: 'exponential', delay: 2000 } }); return report; }
  list(user: AuthUser) { return this.prisma.report.findMany({ where: user.role === Role.ADMIN ? {} : { requestedBy: user.id }, orderBy: { createdAt: 'desc' } }); }
  async get(id: string, user: AuthUser) { const report = await this.prisma.report.findFirst({ where: { id, ...(user.role === Role.ADMIN ? {} : { requestedBy: user.id }) } }); if (!report) throw new NotFoundException('REPORT_NOT_FOUND'); return report; }
  async download(id: string, user: AuthUser) { const report = await this.get(id, user); if (report.status !== 'SUCCESS' || !report.filePath || !existsSync(report.filePath)) throw new NotFoundException('REPORT_FILE_NOT_FOUND'); return report; }
}
