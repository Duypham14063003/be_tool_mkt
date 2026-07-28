import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { KpisModule } from '../kpis/kpis.module';
import { ReportProcessor } from './report.processor';
import { ReportExportService } from './report-export.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
@Module({
  imports: [BullModule.registerQueue({ name: 'report-generation' }), KpisModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportProcessor, ReportExportService],
})
export class ReportsModule {}
