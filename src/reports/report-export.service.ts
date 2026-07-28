import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform, Post, PostMetric, Role } from '@prisma/client';
import ExcelJS from 'exceljs';
import { mkdir } from 'fs/promises';
import { relative, resolve } from 'path';
import { chromium } from 'playwright';
import { PrismaService } from '../database/prisma.service';
import { KpiPerformance, KpisService } from '../kpis/kpis.service';

type ExportPost = Post & { metrics: PostMetric[] };
@Injectable()
export class ReportExportService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private kpis: KpisService,
  ) {}
  async generate(reportId: string): Promise<string> {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    const posts = await this.prisma.post.findMany({
      where: {
        ...(report.platform ? { platform: report.platform } : {}),
        publishedAt: { gte: report.dateFrom, lte: this.endOfDay(report.dateTo) },
        platformAccount: { userId: report.requestedBy },
      },
      include: { metrics: { orderBy: { metricDate: 'desc' }, take: 1 } },
      orderBy: { publishedAt: 'asc' },
    });
    const requester = await this.prisma.user.findUniqueOrThrow({
      where: { id: report.requestedBy },
    });
    const kpiPerformance = await this.kpis.performance(
      {
        id: requester.id,
        email: requester.email,
        role: Role.MARKETING,
        sessionId: 'report-generation',
      },
      report.platform ?? undefined,
      report.dateFrom.toISOString(),
      report.dateTo.toISOString(),
    );
    const root = resolve(this.config.get('REPORT_STORAGE_PATH', './reports'));
    await mkdir(root, { recursive: true });
    const filename = `marketing-report-${report.id}.${report.format === 'PDF' ? 'pdf' : 'xlsx'}`;
    const filePath = resolve(root, filename);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || relativePath.includes(':')) {
      throw new Error('Invalid report path');
    }
    if (report.format === 'PDF') {
      await this.writePdf(
        filePath,
        posts,
        kpiPerformance,
        report.platform,
        report.dateFrom,
        report.dateTo,
      );
      return filePath;
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Marketing Analytics';
    const platforms = report.platform ? [report.platform] : [Platform.FACEBOOK, Platform.TIKTOK];
    for (const platform of platforms)
      this.addSheet(
        workbook,
        platform,
        posts.filter((post) => post.platform === platform),
        kpiPerformance.filter((kpi) => kpi.platform === platform),
        report.dateFrom,
        report.dateTo,
      );
    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }

  private async writePdf(
    filePath: string,
    posts: ExportPost[],
    kpis: KpiPerformance[],
    selectedPlatform: Platform | null,
    from: Date,
    to: Date,
  ): Promise<void> {
    const platforms = selectedPlatform ? [selectedPlatform] : [Platform.FACEBOOK, Platform.TIKTOK];
    const sections = platforms
      .map((platform) => {
        const platformKpis = kpis.filter((kpi) => kpi.platform === platform);
        const kpiRows = platformKpis
          .map(
            (kpi) => `<tr>
        <td>${this.escapeHtml(kpi.metricName)}</td>
        <td>${kpi.targetValue.toString()}</td>
        <td>${kpi.actual ?? '--'}</td>
        <td>${kpi.achievementRate == null ? '--' : `${kpi.achievementRate}%`}</td>
        <td>${kpi.status ?? '--'}</td>
      </tr>`,
          )
          .join('');
        const rows = posts
          .filter((post) => post.platform === platform)
          .map((post, index) => {
            const metric = post.metrics[0];
            const value = (input: unknown) => (input == null ? '--' : String(input));
            return `<tr>
            <td>${index + 1}</td>
            <td>${post.publishedAt.toLocaleDateString('vi-VN')}</td>
            <td class="caption">${this.escapeHtml(post.caption ?? '--')}</td>
            <td>${value(metric?.views)}</td>
            <td>${value(metric?.viewers ?? metric?.reach)}</td>
            <td>${value(metric?.likes ?? metric?.reactions)}</td>
            <td>${value(metric?.comments)}</td>
            <td>${value(metric?.shares)}</td>
            <td>${value(metric?.saves)}</td>
            <td>${value(metric?.totalWatchTimeSeconds)}</td>
            <td>${value(metric?.averageWatchTimeSeconds)}</td>
            <td>${value(metric?.completionRate)}</td>
            <td>${value(metric?.newFollowers)}</td>
            <td>${this.escapeHtml(metric?.trafficSource ?? '--')}</td>
            <td>${value(metric?.maleRate)}</td>
            <td>${value(metric?.femaleRate)}</td>
            <td>${this.escapeHtml(metric?.mainAgeGroup ?? '--')}</td>
            <td>${this.escapeHtml(metric?.mainLocation ?? '--')}</td>
          </tr>`;
          })
          .join('');
        return `<h2>${platform === Platform.TIKTOK ? 'TikTok' : 'Facebook'}</h2>
        <h3>Kết quả KPI</h3>
        <table class="kpi-table">
          <thead><tr><th>Chỉ số</th><th>Mục tiêu</th><th>Thực tế</th><th>Tỷ lệ đạt</th><th>Trạng thái</th></tr></thead>
          <tbody>${kpiRows || '<tr><td colspan="5">Chưa thiết lập KPI</td></tr>'}</tbody>
        </table>
        <h3>Chi tiết bài đăng</h3>
        <table>
          <thead><tr><th>STT</th><th>Ngày</th><th>Caption</th><th>Lượt xem</th>
          <th>Người xem</th><th>Like</th><th>Bình luận</th><th>Chia sẻ</th>
          <th>Lưu video</th><th>Tổng thời gian phát</th><th>Thời gian xem TB</th>
          <th>Tỷ lệ xem hết</th><th>Follow mới</th><th>Nguồn chính</th>
          <th>Nam</th><th>Nữ</th><th>Độ tuổi chính</th><th>Khu vực chính</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="18">Không có dữ liệu</td></tr>'}</tbody>
        </table>`;
      })
      .join('<div class="page-break"></div>');
    const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>
      @page{size:A4 landscape;margin:8mm}body{font-family:Arial,sans-serif;color:#1a1e26}
      h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:14px 0 6px}h3{font-size:11px;margin:8px 0 4px}
      p{font-size:10px;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:7px}
      th,td{border:1px solid #c8c8c8;padding:3px;text-align:center;vertical-align:top}
      th{background:#d0d9ea;font-weight:700}.caption{text-align:left;max-width:42mm}
      .kpi-table{width:auto;min-width:55%;margin-bottom:8px}.page-break{break-before:page}
    </style></head><body><h1>BÁO CÁO SOCIAL ANALYTICS</h1>
      <p>${from.toLocaleDateString('vi-VN')} – ${to.toLocaleDateString('vi-VN')}</p>
      ${sections}</body></html>`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({ path: filePath, format: 'A4', landscape: true, printBackground: true });
    } finally {
      await browser.close();
    }
  }

  private escapeHtml(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;',
        })[character]!,
    );
  }
  private addSheet(
    workbook: ExcelJS.Workbook,
    platform: Platform,
    posts: ExportPost[],
    kpis: KpiPerformance[],
    from: Date,
    to: Date,
  ): void {
    const sheet = workbook.addWorksheet(platform === Platform.FACEBOOK ? 'Facebook' : 'TikTok', {
      views: [{ state: 'frozen', ySplit: 4 }],
    });
    const labels =
      platform === Platform.FACEBOOK
        ? [
            'STT',
            'Ngày đăng',
            'Loại',
            'Caption',
            'Reach',
            'Lượt xem',
            'Tương tác',
            'Xem từ 3 giây',
            'Xem từ 1 phút',
            'Tỷ lệ tương tác',
            'KPI',
            'Tỷ lệ đạt KPI',
          ]
        : [
            'STT',
            'Ngày đăng',
            'Caption',
            'Lượt xem',
            'Người xem',
            'Like',
            'Bình luận',
            'Chia sẻ',
            'Lưu video',
            'Tổng thời gian phát',
            'Thời gian xem trung bình',
            'Tỷ lệ xem hết',
            'Follow mới',
            'Nguồn chính',
            'Người xem mới',
            'Người xem quay lại',
            'Nam',
            'Nữ',
            'Độ tuổi chính',
            'Khu vực chính',
            'Engagement rate',
            'KPI',
            'Tỷ lệ đạt KPI',
          ];
    sheet.mergeCells(1, 1, 1, labels.length);
    sheet.getCell(1, 1).value = `BÁO CÁO MARKETING ${platform}`;
    sheet.mergeCells(2, 1, 2, labels.length);
    sheet.getCell(2, 1).value =
      `Khoảng thời gian: ${from.toISOString().slice(0, 10)} - ${to.toISOString().slice(0, 10)}`;
    sheet.addRow([]);
    sheet.addRow(labels);
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    for (const [index, post] of posts.entries()) {
      const m = post.metrics[0];
      const n = (v: bigint | null | undefined): string | number =>
        v === null || v === undefined ? '--' : Number(v);
      const d = (v: { toNumber(): number } | null | undefined): string | number =>
        v ? v.toNumber() / 100 : '--';
      const engagement =
        m && m.reactions !== null && m.comments !== null && m.shares !== null
          ? Number(m.reactions + m.comments + m.shares)
          : '--';
      const applicableKpis = kpis.filter(
        (kpi) =>
          post.publishedAt >= kpi.periodStart && post.publishedAt <= this.endOfDay(kpi.periodEnd),
      );
      const kpiTargets = applicableKpis.length
        ? applicableKpis.map((kpi) => `${kpi.metricName}: ${kpi.targetValue}`).join('\n')
        : '--';
      const kpiRates = applicableKpis.length
        ? applicableKpis
            .map(
              (kpi) =>
                `${kpi.metricName}: ${kpi.achievementRate == null ? '--' : `${kpi.achievementRate}%`}`,
            )
            .join('\n')
        : '--';
      sheet.addRow(
        platform === Platform.FACEBOOK
          ? [
              index + 1,
              post.publishedAt,
              post.contentType,
              post.caption ?? '--',
              n(m?.reach),
              n(m?.views),
              engagement,
              n(m?.view3Seconds),
              n(m?.view1Minute),
              d(m?.engagementRate),
              kpiTargets,
              kpiRates,
            ]
          : [
              index + 1,
              post.publishedAt,
              post.caption ?? '--',
              n(m?.views),
              n(m?.viewers),
              n(m?.likes),
              n(m?.comments),
              n(m?.shares),
              n(m?.saves),
              m?.totalWatchTimeSeconds?.toNumber() ?? '--',
              m?.averageWatchTimeSeconds?.toNumber() ?? '--',
              d(m?.completionRate),
              n(m?.newFollowers),
              m?.trafficSource ?? '--',
              d(m?.newViewerRate),
              d(m?.returningViewerRate),
              d(m?.maleRate),
              d(m?.femaleRate),
              m?.mainAgeGroup ?? '--',
              m?.mainLocation ?? '--',
              d(m?.engagementRate),
              kpiTargets,
              kpiRates,
            ],
      );
    }
    const totalRow = sheet.addRow(['TỔNG']);
    sheet.mergeCells(totalRow.number, 1, totalRow.number, platform === Platform.FACEBOOK ? 4 : 3);
    totalRow.font = { bold: true };
    const firstDataRow = 5;
    const lastDataRow = totalRow.number - 1;
    if (posts.length) {
      const sum = (column: number) => {
        totalRow.getCell(column).value = {
          formula: `SUM(${sheet.getColumn(column).letter}${firstDataRow}:${sheet.getColumn(column).letter}${lastDataRow})`,
        };
      };
      const average = (column: number) => {
        totalRow.getCell(column).value = {
          formula: `IFERROR(AVERAGE(${sheet.getColumn(column).letter}${firstDataRow}:${sheet.getColumn(column).letter}${lastDataRow}),0)`,
        };
      };
      if (platform === Platform.FACEBOOK) {
        [5, 6, 7, 8, 9].forEach(sum);
        totalRow.getCell(10).value = {
          formula: `IFERROR(G${totalRow.number}/E${totalRow.number},0)`,
        };
      } else {
        [4, 5, 6, 7, 8, 9, 10, 13].forEach(sum);
        [11, 12, 15, 16, 17, 18].forEach(average);
        totalRow.getCell(21).value = {
          formula: `IFERROR((F${totalRow.number}+G${totalRow.number}+H${totalRow.number}+I${totalRow.number})/D${totalRow.number},0)`,
        };
      }
    }
    totalRow.getCell(labels.length - 1).value = kpis.length
      ? kpis.map((kpi) => `${kpi.metricName}: ${kpi.targetValue}`).join('\n')
      : '--';
    totalRow.getCell(labels.length).value = kpis.length
      ? kpis
          .map(
            (kpi) =>
              `${kpi.metricName}: ${kpi.achievementRate == null ? '--' : `${kpi.achievementRate}%`}`,
          )
          .join('\n')
      : '--';
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: Math.max(4, sheet.rowCount - 1), column: labels.length },
    };
    sheet.columns.forEach((column, index) => {
      column.width = Math.min(45, Math.max(12, labels[index]?.length + 2 || 12));
    });
    const captionColumn = platform === Platform.FACEBOOK ? 4 : 3;
    sheet.getColumn(captionColumn).width = 45;
    sheet.getColumn(captionColumn).alignment = { wrapText: true, vertical: 'top' };
    const percentageColumns = platform === Platform.FACEBOOK ? [10] : [12, 15, 16, 17, 18, 21];
    percentageColumns.forEach((column) => {
      sheet.getColumn(column).numFmt = '0.00%';
    });
    sheet.getColumn(labels.length - 1).alignment = { wrapText: true, vertical: 'top' };
    sheet.getColumn(labels.length).alignment = { wrapText: true, vertical: 'top' };
    sheet.getColumn(2).numFmt = 'dd/mm/yyyy';
  }

  private endOfDay(date: Date): Date {
    const result = new Date(date);
    result.setUTCHours(23, 59, 59, 999);
    return result;
  }
}
