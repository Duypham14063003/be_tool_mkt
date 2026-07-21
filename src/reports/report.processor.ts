import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { ReportExportService } from './report-export.service';
@Processor('report-generation', { concurrency: 2 })
export class ReportProcessor extends WorkerHost {
  constructor(private prisma: PrismaService, private exporter: ReportExportService) { super(); }
  async process(job: Job<{ reportId: string }>): Promise<{ filePath: string }> { await this.prisma.report.update({ where: { id: job.data.reportId }, data: { status: 'RUNNING' } }); try { const filePath = await this.exporter.generate(job.data.reportId); await this.prisma.report.update({ where: { id: job.data.reportId }, data: { status: 'SUCCESS', filePath, finishedAt: new Date() } }); return { filePath }; } catch (error) { await this.prisma.report.update({ where: { id: job.data.reportId }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message : 'REPORT_GENERATION_FAILED', finishedAt: new Date() } }); throw error; } }
}
