import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform, Post, PostMetric } from '@prisma/client';
import ExcelJS from 'exceljs';
import { mkdir } from 'fs/promises';
import { resolve } from 'path';
import { PrismaService } from '../database/prisma.service';

type ExportPost = Post & { metrics: PostMetric[] };
@Injectable()
export class ReportExportService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}
  async generate(reportId: string): Promise<string> {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    const posts = await this.prisma.post.findMany({ where: { ...(report.platform ? { platform: report.platform } : {}), publishedAt: { gte: report.dateFrom, lte: report.dateTo }, platformAccount: { userId: report.requestedBy } }, include: { metrics: { orderBy: { metricDate: 'desc' }, take: 1 } }, orderBy: { publishedAt: 'asc' } });
    const root = resolve(this.config.get('REPORT_STORAGE_PATH', './reports'));
    await mkdir(root, { recursive: true });
    const filename = `marketing-report-${report.id}.xlsx`;
    const filePath = resolve(root, filename);
    if (!filePath.startsWith(`${root}/`)) throw new Error('Invalid report path');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Marketing Analytics';
    const platforms = report.platform ? [report.platform] : [Platform.FACEBOOK, Platform.TIKTOK];
    for (const platform of platforms) this.addSheet(workbook, platform, posts.filter((post) => post.platform === platform), report.dateFrom, report.dateTo);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }
  private addSheet(workbook: ExcelJS.Workbook, platform: Platform, posts: ExportPost[], from: Date, to: Date): void {
    const sheet = workbook.addWorksheet(platform === Platform.FACEBOOK ? 'Facebook' : 'TikTok', { views: [{ state: 'frozen', ySplit: 4 }] });
    const labels = platform === Platform.FACEBOOK
      ? ['STT','Ngày đăng','Loại','Caption','Reach','Lượt xem','Tương tác','Xem từ 3 giây','Xem từ 1 phút','Tỷ lệ tương tác','KPI','Tỷ lệ đạt KPI']
      : ['STT','Ngày đăng','Caption','Lượt xem','Người xem','Like','Bình luận','Chia sẻ','Lưu video','Tổng thời gian phát','Thời gian xem trung bình','Tỷ lệ xem hết','Follow mới','Nguồn chính','Người xem mới','Người xem quay lại','Nam','Nữ','Độ tuổi chính','Khu vực chính','Engagement rate','KPI','Tỷ lệ đạt KPI'];
    sheet.mergeCells(1, 1, 1, labels.length); sheet.getCell(1, 1).value = `BÁO CÁO MARKETING ${platform}`;
    sheet.mergeCells(2, 1, 2, labels.length); sheet.getCell(2, 1).value = `Khoảng thời gian: ${from.toISOString().slice(0,10)} - ${to.toISOString().slice(0,10)}`;
    sheet.addRow([]); sheet.addRow(labels);
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    for (const [index, post] of posts.entries()) {
      const m = post.metrics[0]; const n = (v: bigint | null | undefined): string | number => v === null || v === undefined ? '--' : Number(v); const d = (v: { toNumber(): number } | null | undefined): string | number => v ? v.toNumber() / 100 : '--';
      const engagement = m && m.reactions !== null && m.comments !== null && m.shares !== null ? Number(m.reactions + m.comments + m.shares) : '--';
      sheet.addRow(platform === Platform.FACEBOOK
        ? [index+1,post.publishedAt,post.contentType,post.caption??'--',n(m?.reach),n(m?.views),engagement,n(m?.view3Seconds),n(m?.view1Minute),d(m?.engagementRate),'--','--']
        : [index+1,post.publishedAt,post.caption??'--',n(m?.views),n(m?.viewers),n(m?.likes),n(m?.comments),n(m?.shares),n(m?.saves),m?.totalWatchTimeSeconds?.toNumber()??'--',m?.averageWatchTimeSeconds?.toNumber()??'--',d(m?.completionRate),n(m?.newFollowers),m?.trafficSource??'--',d(m?.newViewerRate),d(m?.returningViewerRate),d(m?.maleRate),d(m?.femaleRate),m?.mainAgeGroup??'--',m?.mainLocation??'--',d(m?.engagementRate),'--','--']);
    }
    const totalRow = sheet.addRow(['TỔNG']); sheet.mergeCells(totalRow.number, 1, totalRow.number, platform === Platform.FACEBOOK ? 4 : 3); totalRow.font = { bold: true };
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, sheet.rowCount - 1), column: labels.length } };
    sheet.columns.forEach((column, index) => { column.width = Math.min(45, Math.max(12, labels[index]?.length + 2 || 12)); });
    const captionColumn = platform === Platform.FACEBOOK ? 4 : 3; sheet.getColumn(captionColumn).width = 45; sheet.getColumn(captionColumn).alignment = { wrapText: true, vertical: 'top' };
    const percentageColumns = platform === Platform.FACEBOOK ? [10,12] : [12,15,16,17,18,21,23]; percentageColumns.forEach((column) => { sheet.getColumn(column).numFmt = '0.00%'; });
    sheet.getColumn(2).numFmt = 'dd/mm/yyyy';
  }
}
