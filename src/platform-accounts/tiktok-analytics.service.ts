import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { BrowserContext, chromium } from 'playwright';
import type { Page } from 'playwright';
import { mkdir } from 'fs/promises';
import { resolve } from 'path';
import { EncryptionService } from '../common/encryption.service';
import { PrismaService } from '../database/prisma.service';
import { NormalizedPost } from '../sync/social-provider';

const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/content';
const TIKTOK_ANALYTICS_DETAIL_BUTTON_XPATH_PREFIX =
  "//body/div[@id='root']/div[@class='css-xpgwd0 edss2sz11']/div[@class='css-1igqfns edss2sz9']/div[@class='css-fsbw52 ep9i2zp0']/div[@class='css-86gjln edss2sz6']/div[@class='css-1jnhfpt edss2sz0']/div[@class='css-1xdux7e edss2sz6']/div[@class='css-1t5uzud edss2sz6']/div[@class='css-mae3oz edss2sz6']/div[@class='css-mae3oz edss2sz6']/div[@class='css-hvkpcx edss2sz6']/div[@class='css-snthx edss2sz11']/div[@class='css-uy6lk3 edss2sz11']/div[@class='css-1g69po8 edss2sz7']/div[@class='css-153feq8 edss2sz9']/div[@class='css-d5h0fp edss2sz9']/div[@class='css-iys6w9 edss2sz9']/div[@class='css-1jhq6dt edss2sz9']";

export interface TikTokAnalyticsMetric {
  views?: number;
  viewers?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  totalWatchTimeSeconds?: number;
  averageWatchTimeSeconds?: number;
  completionRate?: number;
  newFollowers?: number;
  trafficSource?: string;
  trafficSources?: Array<{ label: string; value: number | string }>;
  newViewerRate?: number;
  returningViewerRate?: number;
  followerRate?: number;
  nonFollowerRate?: number;
  maleRate?: number;
  femaleRate?: number;
  otherGenderRate?: number;
  mainAgeGroup?: string;
  ageGroups?: Array<{ label: string; value: number | string }>;
  mainLocation?: string;
  locations?: Array<{ label: string; value: number | string }>;
  commentKeywords?: Array<{ label: string; value: number | string }>;
  rawTabs?: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;
type ScanProgress = (event: {
  message: string;
  progress?: number;
  processedItems?: number;
  totalItems?: number;
  context?: JsonObject;
}) => Promise<void> | void;

@Injectable()
export class TikTokAnalyticsService {
  private readonly logger = new Logger(TikTokAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async captureSession(
    platformAccountId: string,
  ): Promise<{ status: 'VALID' | 'REQUIRES_LOGIN'; message: string }> {
    this.logger.log(`Opening TikTok Studio for account ${platformAccountId}`);
    const timeoutSeconds = this.config.get<number>('PLAYWRIGHT_LOGIN_TIMEOUT_SECONDS', 180);
    const context = await this.launchPersistentContext(platformAccountId, this.shouldRunHeadless());
    this.logger.log(`TikTok Studio login timeout: ${timeoutSeconds}s`);

    try {
      const page = await context.newPage();
      this.attachPageDebugLogs(page, 'captureSession');
      this.logger.log(
        `TikTok Studio browser userAgent: ${await page.evaluate(() => navigator.userAgent)}`,
      );
      const initialResponse = await page.goto(TIKTOK_STUDIO_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      this.logger.log(
        `TikTok Studio initial goto: status=${initialResponse?.status() ?? 'n/a'} url=${page.url()}`,
      );

      const authenticated = await this.waitForLogin(context, page, timeoutSeconds * 1_000);
      if (!authenticated) {
        this.logger.warn(
          `TikTok Studio login timed out: finalUrl=${page.url()} cookies=${await this.describeTikTokCookies(context)}`,
        );
        return {
          status: 'REQUIRES_LOGIN',
          message: `Hãy đăng nhập TikTok Studio trong ${timeoutSeconds} giây rồi thử lại.`,
        };
      }
      this.logger.log(
        `TikTok Studio login detected: finalUrl=${page.url()} cookies=${await this.describeTikTokCookies(context)}`,
      );

      const storageState = await context.storageState();
      const now = new Date();
      await this.prisma.browserSession.upsert({
        where: { platformAccountId },
        create: {
          platformAccountId,
          encryptedStorageState: this.encryption.encrypt(JSON.stringify(storageState)),
          sessionStatus: 'VALID',
          lastValidatedAt: now,
        },
        update: {
          encryptedStorageState: this.encryption.encrypt(JSON.stringify(storageState)),
          sessionStatus: 'VALID',
          lastValidatedAt: now,
          expiresAt: null,
        },
      });
      await this.prisma.platformAccount.update({
        where: { id: platformAccountId },
        data: { connectionStatus: 'CONNECTED' },
      });
      this.logger.log(`TikTok Studio session persisted for account ${platformAccountId}`);

      return { status: 'VALID', message: 'Đã lưu phiên đăng nhập TikTok Studio.' };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async collect(
    platformAccountId: string,
    postIds: string[],
    onProgress?: ScanProgress,
  ): Promise<Map<string, TikTokAnalyticsMetric>> {
    const session = await this.prisma.browserSession.findUnique({
      where: { platformAccountId },
    });
    if (!session || session.sessionStatus !== 'VALID') {
      throw new UnauthorizedException('Chưa kết nối phiên đăng nhập TikTok Studio.');
    }

    const context = await this.launchPersistentContext(platformAccountId, this.shouldRunHeadless());
    const metrics = new Map<string, TikTokAnalyticsMetric>();
    const requestedIds = new Set(postIds.map(String));
    const pendingResponses: Promise<void>[] = [];

    try {
      const page = await context.newPage();
      this.attachPageDebugLogs(page, 'collect');
      page.on('response', (response) => {
        if (!response.url().includes('tiktok.com') || !this.isJsonResponse(response.headers()))
          return;
        pendingResponses.push(
          response
            .json()
            .then((payload: unknown) => this.extractMetrics(payload, requestedIds, metrics))
            .catch(() => undefined),
        );
      });

      await onProgress?.({
        message: 'Đang mở TikTok Studio để lấy analytics',
        progress: 35,
        totalItems: postIds.length,
      });
      await page.goto(TIKTOK_STUDIO_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      this.logger.log(`TikTok Studio collect page loaded: url=${page.url()}`);
      if (!(await this.hasAuthenticatedCookie(context))) {
        this.logger.warn(
          `TikTok Studio collect has no auth cookie: url=${page.url()} cookies=${await this.describeTikTokCookies(context)}`,
        );
        await this.markSessionExpired(platformAccountId);
        throw new UnauthorizedException('Phiên TikTok Studio đã hết hạn. Vui lòng kết nối lại.');
      }

      await onProgress?.({
        message: 'Đã đăng nhập, đang tải danh sách video analytics',
        progress: 40,
        totalItems: postIds.length,
      });
      await this.openStudioPostsPage(page, onProgress, 41);
      await page.waitForTimeout(5_000);
      await this.openPostAnalyticsDetails(page, pendingResponses, postIds, metrics, onProgress);
      await Promise.allSettled(pendingResponses);

      await this.prisma.browserSession.update({
        where: { platformAccountId },
        data: {
          lastValidatedAt: new Date(),
          encryptedStorageState: this.encryption.encrypt(
            JSON.stringify(await context.storageState()),
          ),
        },
      });
      this.logger.log(
        `Collected TikTok Studio metrics for ${metrics.size}/${postIds.length} videos`,
      );
      return metrics;
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async collectPosts(
    platformAccountId: string,
    from: Date,
    to: Date,
    onProgress?: ScanProgress,
  ): Promise<NormalizedPost[]> {
    const session = await this.prisma.browserSession.findUnique({
      where: { platformAccountId },
    });
    if (!session || session.sessionStatus !== 'VALID') {
      throw new UnauthorizedException('Chưa kết nối phiên đăng nhập TikTok Studio.');
    }

    const context = await this.launchPersistentContext(platformAccountId, this.shouldRunHeadless());
    const posts = new Map<string, NormalizedPost>();
    const pendingResponses: Promise<void>[] = [];

    try {
      const page = await context.newPage();
      this.attachPageDebugLogs(page, 'collectPosts');
      page.on('response', (response) => {
        if (!response.url().includes('tiktok.com') || !this.isJsonResponse(response.headers()))
          return;
        pendingResponses.push(
          response
            .json()
            .then((payload: unknown) => this.extractStudioPosts(payload, from, to, posts))
            .catch(() => undefined),
        );
      });

      await onProgress?.({ message: 'Đang mở TikTok Studio trong nền', progress: 8 });
      await page.goto(TIKTOK_STUDIO_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      this.logger.log(`TikTok Studio collectPosts page loaded: url=${page.url()}`);
      if (!(await this.hasAuthenticatedCookie(context))) {
        this.logger.warn(
          `TikTok Studio collectPosts has no auth cookie: url=${page.url()} cookies=${await this.describeTikTokCookies(context)}`,
        );
        await this.markSessionExpired(platformAccountId);
        throw new UnauthorizedException('Phiên TikTok Studio đã hết hạn. Vui lòng kết nối lại.');
      }

      await onProgress?.({ message: 'Đã đăng nhập, đang tải danh sách video', progress: 15 });
      await this.openStudioPostsPage(page, onProgress, 16);
      await page.waitForTimeout(5_000);
      await this.autoScroll(page, onProgress, 'Đang scan danh sách video TikTok Studio', 18, 30);
      await Promise.allSettled(pendingResponses);

      await this.prisma.browserSession.update({
        where: { platformAccountId },
        data: {
          lastValidatedAt: new Date(),
          encryptedStorageState: this.encryption.encrypt(
            JSON.stringify(await context.storageState()),
          ),
        },
      });
      await onProgress?.({
        message: `Đã scan được ${posts.size} video từ TikTok Studio`,
        progress: 32,
        totalItems: posts.size,
        context: { collectedPosts: posts.size },
      });
      this.logger.log(`Collected ${posts.size} TikTok Studio posts from network responses`);
      return [...posts.values()].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async waitForLogin(
    context: BrowserContext,
    page: Page,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (attempts === 0 || attempts % 5 === 0) {
        this.logger.log(
          `TikTok Studio login wait: elapsed=${attempts}s url=${page.url()} cookies=${await this.describeTikTokCookies(context)}`,
        );
      }
      if (await this.hasAuthenticatedCookie(context)) return true;
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  private async hasAuthenticatedCookie(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies();
    return cookies.some(
      (cookie) =>
        cookie.domain.includes('tiktok.com') &&
        [
          'sessionid',
          'sessionid_ss',
          'sid_guard',
          'sid_tt',
          'uid_tt',
          'uid_tt_ss',
          'sid_ucp_v1',
          'ssid_ucp_v1',
        ].includes(cookie.name) &&
        cookie.value,
    );
  }

  private async describeTikTokCookies(context: BrowserContext): Promise<string> {
    const cookies = await context.cookies();
    const tiktokCookies = cookies
      .filter((cookie) => cookie.domain.includes('tiktok.com'))
      .map((cookie) => `${cookie.name}@${cookie.domain}`)
      .sort();
    return tiktokCookies.length ? tiktokCookies.join(',') : 'none';
  }

  private attachPageDebugLogs(page: Page, scope: string): void {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.logger.log(`TikTok Studio ${scope} navigated: ${frame.url()}`);
      }
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (!url.includes('tiktok.com')) return;
      this.logger.warn(
        `TikTok Studio ${scope} request failed: ${request.method()} ${url} ${request.failure()?.errorText ?? ''}`.trim(),
      );
    });
    page.on('response', (response) => {
      const url = response.url();
      if (!url.includes('tiktok.com')) return;
      const status = response.status();
      if (status >= 300) {
        this.logger.log(`TikTok Studio ${scope} response: status=${status} url=${url}`);
      }
    });
  }

  private async markSessionExpired(platformAccountId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.browserSession.updateMany({
        where: { platformAccountId },
        data: { sessionStatus: 'EXPIRED' },
      }),
      this.prisma.platformAccount.update({
        where: { id: platformAccountId },
        data: { connectionStatus: 'EXPIRED' },
      }),
    ]);
  }

  private isJsonResponse(headers: Record<string, string>): boolean {
    return (headers['content-type'] ?? '').includes('json');
  }

  private extractMetrics(
    value: unknown,
    requestedIds: Set<string>,
    output: Map<string, TikTokAnalyticsMetric>,
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item) => this.extractMetrics(item, requestedIds, output));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const row = value as JsonObject;
    const videoId = this.stringValue(row, ['video_id', 'item_id', 'aweme_id', 'group_id', 'id']);
    if (videoId && requestedIds.has(videoId)) {
      const data = this.flattenObject(row);
      const current = output.get(videoId) ?? {};
      output.set(videoId, {
        ...current,
        viewers:
          this.numberValue(data, ['unique_viewers', 'viewer_count', 'viewers']) ?? current.viewers,
        saves:
          this.numberValue(data, [
            'favorites_count',
            'favourite_count',
            'collect_count',
            'saves',
          ]) ?? current.saves,
        totalWatchTimeSeconds:
          this.numberValue(data, [
            'total_time_watched',
            'total_watch_time',
            'total_watch_time_seconds',
          ]) ?? current.totalWatchTimeSeconds,
        averageWatchTimeSeconds:
          this.numberValue(data, [
            'average_time_watched',
            'avg_watch_time',
            'average_watch_time_seconds',
          ]) ?? current.averageWatchTimeSeconds,
        completionRate:
          this.percentValue(data, [
            'watched_full_video_pct',
            'full_video_watch_rate',
            'completion_rate',
          ]) ?? current.completionRate,
        newFollowers:
          this.numberValue(data, ['new_followers', 'followers_gained']) ?? current.newFollowers,
        trafficSource:
          this.stringValue(data, ['main_traffic_source', 'top_traffic_source', 'traffic_source']) ??
          this.topBreakdown(
            row,
            ['traffic_source', 'traffic_sources'],
            ['source', 'name', 'label'],
          ) ??
          current.trafficSource,
        newViewerRate:
          this.percentValue(data, ['new_viewer_rate', 'new_viewers_pct', 'new_audience_rate']) ??
          current.newViewerRate,
        returningViewerRate:
          this.percentValue(data, [
            'returning_viewer_rate',
            'returning_viewers_pct',
            'returning_audience_rate',
          ]) ?? current.returningViewerRate,
        maleRate: this.percentValue(data, ['male_rate', 'male_pct']) ?? current.maleRate,
        femaleRate: this.percentValue(data, ['female_rate', 'female_pct']) ?? current.femaleRate,
        mainAgeGroup:
          this.stringValue(data, ['main_age_group', 'top_age_group']) ??
          this.topBreakdown(
            row,
            ['age_distribution', 'age_groups'],
            ['age_group', 'name', 'label'],
          ) ??
          current.mainAgeGroup,
        mainLocation:
          this.stringValue(data, ['main_location', 'top_location', 'top_country']) ??
          this.topBreakdown(
            row,
            ['location_distribution', 'country_distribution', 'territories'],
            ['country', 'location', 'name'],
          ) ??
          current.mainLocation,
      });
    }

    Object.values(row).forEach((item) => this.extractMetrics(item, requestedIds, output));
  }

  private extractStudioPosts(
    value: unknown,
    from: Date,
    to: Date,
    output: Map<string, NormalizedPost>,
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item) => this.extractStudioPosts(item, from, to, output));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const row = value as JsonObject;
    const data = this.flattenObject(row);
    const externalPostId = this.stringValue(data, [
      'video_id',
      'item_id',
      'aweme_id',
      'group_id',
      'id',
    ]);
    if (externalPostId) {
      const views = this.numberValue(data, ['video_views', 'view_count', 'views', 'play_count']);
      const likes = this.numberValue(data, ['like_count', 'likes', 'digg_count']);
      const comments = this.numberValue(data, ['comment_count', 'comments']);
      const shares = this.numberValue(data, ['share_count', 'shares']);
      const saves = this.numberValue(data, [
        'favorites_count',
        'favourite_count',
        'collect_count',
        'save_count',
        'saves',
      ]);
      const publishedAt = this.dateValue(data, [
        'create_time',
        'createTime',
        'publish_time',
        'publishTime',
        'date',
        'publish_date',
      ]);
      const hasMetric = [views, likes, comments, shares, saves].some((item) => item != null);
      const hasContent = Boolean(
        this.stringValue(data, ['title', 'desc', 'description', 'video_description', 'caption']) ||
        this.stringValue(data, ['share_url', 'url', 'video_url', 'cover_url', 'cover_image_url']),
      );

      if (
        (hasMetric || hasContent) &&
        (!publishedAt || (publishedAt >= from && publishedAt <= to))
      ) {
        const totalWatchTimeSeconds = this.numberValue(data, [
          'total_time_watched',
          'total_watch_time',
          'total_watch_time_seconds',
        ]);
        const averageWatchTimeSeconds = this.numberValue(data, [
          'average_time_watched',
          'avg_watch_time',
          'average_watch_time_seconds',
        ]);
        const completionRate = this.percentValue(data, [
          'watched_full_video_pct',
          'full_video_watch_rate',
          'completion_rate',
          'video_completion_rate',
        ]);
        const maleRate = this.percentValue(data, ['male_rate', 'male_pct']);
        const femaleRate = this.percentValue(data, ['female_rate', 'female_pct']);
        const current = output.get(externalPostId);
        const normalized = this.normalizeStudioPost({
          externalPostId,
          caption:
            this.stringValue(data, [
              'title',
              'desc',
              'description',
              'video_description',
              'caption',
            ]) ??
            current?.caption ??
            null,
          postUrl:
            this.stringValue(data, ['share_url', 'url', 'video_url']) ?? current?.postUrl ?? null,
          thumbnailUrl:
            this.stringValue(data, ['cover_url', 'cover_image_url', 'thumbnail_url']) ??
            current?.thumbnailUrl ??
            null,
          durationSeconds:
            this.numberValue(data, ['duration', 'duration_seconds']) ??
            current?.durationSeconds ??
            null,
          publishedAt: publishedAt ?? current?.publishedAt ?? new Date(),
          views,
          viewers: this.numberValue(data, ['unique_viewers', 'viewer_count', 'viewers']),
          likes,
          comments,
          shares,
          saves,
          totalWatchTimeSeconds,
          averageWatchTimeSeconds,
          completionRate,
          newFollowers: this.numberValue(data, [
            'new_followers',
            'followers_gained',
            'new_followers_count',
          ]),
          trafficSource:
            this.stringValue(data, [
              'main_traffic_source',
              'top_traffic_source',
              'traffic_source',
            ]) ??
            this.topBreakdown(
              row,
              ['traffic_source', 'traffic_sources'],
              ['source', 'name', 'label'],
            ),
          newViewerRate: this.percentValue(data, [
            'new_viewer_rate',
            'new_viewers_pct',
            'new_audience_rate',
          ]),
          returningViewerRate: this.percentValue(data, [
            'returning_viewer_rate',
            'returning_viewers_pct',
            'returning_audience_rate',
          ]),
          maleRate,
          femaleRate,
          mainAgeGroup:
            this.stringValue(data, ['main_age_group', 'top_age_group']) ??
            this.topBreakdown(
              row,
              ['age_distribution', 'age_groups'],
              ['age_group', 'name', 'label'],
            ),
          mainLocation:
            this.stringValue(data, ['main_location', 'top_location', 'top_country']) ??
            this.topBreakdown(
              row,
              ['location_distribution', 'country_distribution', 'territories'],
              ['country', 'location', 'name'],
            ),
          rawData: current?.metric.rawData ?? {},
        });
        output.set(externalPostId, normalized);
      }
    }

    Object.values(row).forEach((item) => this.extractStudioPosts(item, from, to, output));
  }

  private normalizeStudioPost(input: {
    externalPostId: string;
    caption: string | null;
    postUrl: string | null;
    thumbnailUrl: string | null;
    durationSeconds: number | null;
    publishedAt: Date;
    views?: number;
    viewers?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    totalWatchTimeSeconds?: number;
    averageWatchTimeSeconds?: number;
    completionRate?: number;
    newFollowers?: number;
    trafficSource?: string;
    newViewerRate?: number;
    returningViewerRate?: number;
    maleRate?: number;
    femaleRate?: number;
    mainAgeGroup?: string;
    mainLocation?: string;
    rawData: Record<string, unknown>;
  }): NormalizedPost {
    const views = input.views ?? 0;
    const likes = input.likes ?? 0;
    const comments = input.comments ?? 0;
    const shares = input.shares ?? 0;
    const saves = input.saves ?? 0;
    const engagementRate = views
      ? Number((((likes + comments + shares + saves) / views) * 100).toFixed(2))
      : null;
    const extended = {
      totalWatchTimeSeconds: input.totalWatchTimeSeconds ?? null,
      averageWatchTimeSeconds: input.averageWatchTimeSeconds ?? null,
      completionRate: input.completionRate ?? null,
      newFollowers: input.newFollowers ?? null,
      trafficSource: input.trafficSource ?? null,
      newViewerRate: input.newViewerRate ?? null,
      returningViewerRate: input.returningViewerRate ?? null,
      maleRate: input.maleRate ?? null,
      femaleRate: input.femaleRate ?? null,
      mainAgeGroup: input.mainAgeGroup ?? null,
      mainLocation: input.mainLocation ?? null,
    };

    return {
      externalPostId: input.externalPostId,
      platform: Platform.TIKTOK,
      contentType: 'VIDEO',
      caption: input.caption,
      postUrl: input.postUrl,
      thumbnailUrl: input.thumbnailUrl,
      durationSeconds: input.durationSeconds,
      publishedAt: input.publishedAt,
      rawData: { source: 'tiktok_studio_playwright' },
      metric: {
        views: BigInt(views),
        reach: null,
        viewers: input.viewers != null ? BigInt(input.viewers) : null,
        reactions: null,
        likes: BigInt(likes),
        comments: BigInt(comments),
        shares: BigInt(shares),
        saves: BigInt(saves),
        view3Seconds: null,
        view1Minute: null,
        engagementRate,
        rawData: { source: 'tiktok_studio_playwright', _extended: extended },
      },
    };
  }

  private stringValue(row: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
      }
    }
    return undefined;
  }

  private numberValue(row: JsonObject, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = row[key];
      const parsed =
        typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private percentValue(row: JsonObject, keys: string[]): number | undefined {
    const value = this.numberValue(row, keys);
    if (value == null) return undefined;
    return value > 0 && value <= 1 ? value * 100 : value;
  }

  private dateValue(row: JsonObject, keys: string[]): Date | undefined {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'number') {
        const date = new Date(value > 10_000_000_000 ? value : value * 1000);
        if (!Number.isNaN(date.getTime())) return date;
      }
      if (typeof value === 'string') {
        const numeric = Number(value);
        const date = Number.isFinite(numeric)
          ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
          : new Date(value);
        if (!Number.isNaN(date.getTime())) return date;
      }
    }
    return undefined;
  }

  private flattenObject(value: unknown, output: JsonObject = {}): JsonObject {
    if (Array.isArray(value)) {
      value.forEach((item) => this.flattenObject(item, output));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as JsonObject)) {
        if (child == null || ['string', 'number', 'bigint'].includes(typeof child))
          output[key] = child;
        else this.flattenObject(child, output);
      }
    }
    return output;
  }

  private topBreakdown(
    value: unknown,
    containerKeys: string[],
    labelKeys: string[],
  ): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as JsonObject;
    for (const key of containerKeys) {
      const entries = row[key];
      if (!Array.isArray(entries)) continue;
      const ranked = entries
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return undefined;
          const item = entry as JsonObject;
          const label = this.stringValue(item, labelKeys);
          const rate = this.percentValue(item, ['percentage', 'percent', 'rate', 'value']);
          return label && rate != null ? { label, rate } : undefined;
        })
        .filter((entry): entry is { label: string; rate: number } => Boolean(entry))
        .sort((a, b) => b.rate - a.rate);
      if (ranked[0]) return `${ranked[0].label} ${ranked[0].rate.toFixed(1)}%`;
    }
    for (const child of Object.values(row)) {
      const found = this.topBreakdown(child, containerKeys, labelKeys);
      if (found) return found;
    }
    return undefined;
  }

  private async autoScroll(
    page: import('playwright').Page,
    onProgress?: ScanProgress,
    message = 'Đang cuộn trang để tải dữ liệu',
    startProgress = 0,
    endProgress = 0,
  ): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1_500);
      await page.waitForTimeout(750);
      if (onProgress && endProgress > startProgress) {
        const progress = Math.round(startProgress + ((i + 1) / 8) * (endProgress - startProgress));
        await onProgress({ message: `${message} (${i + 1}/8)`, progress });
      }
    }
  }

  private async openStudioPostsPage(
    page: Page,
    onProgress?: ScanProgress,
    progress?: number,
  ): Promise<void> {
    await onProgress?.({ message: 'Đang chuyển sang mục Bài đăng TikTok Studio', progress });
    const candidates = [
      page.locator('[data-tt="Sidebar_Sidebar_Clickable"]').nth(1),
      page.getByText('Bài đăng', { exact: true }),
      page.locator('[data-tt="Sidebar_Sidebar_Clickable"]').filter({ hasText: 'Bài đăng' }).first(),
    ];
    for (const candidate of candidates) {
      if (!(await candidate.count().catch(() => 0))) continue;
      const clicked = await candidate
        .first()
        .click({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(3_000);
      await onProgress?.({
        message: 'Đã vào mục Bài đăng, chuẩn bị đọc danh sách video',
        progress,
        context: { url: page.url() },
      });
      return;
    }
    const sidebarButtons = await page
      .locator('[data-tt="Sidebar_Sidebar_Clickable"]')
      .count()
      .catch(() => 0);
    await onProgress?.({
      message: 'Không tìm thấy nút sidebar Bài đăng TikTok Studio',
      progress,
      context: { url: page.url(), sidebarButtons },
    });
  }

  private async openPostAnalyticsDetails(
    page: Page,
    pendingResponses: Promise<void>[],
    postIds: string[],
    metrics: Map<string, TikTokAnalyticsMetric>,
    onProgress?: ScanProgress,
  ): Promise<void> {
    const maxDetails = this.config.get<number>('TIKTOK_STUDIO_DETAIL_LIMIT', postIds.length);
    let counts = await this.countAnalyticsDetailTargets(page, maxDetails);
    const visibleRows = Math.max(
      counts.actionRows,
      counts.actionCellGroups,
      counts.labeledButtons,
      counts.exactXPath,
      counts.softXPath,
      counts.analyticsText,
      counts.rows > 1 ? counts.rows - 1 : counts.rows,
    );

    if (!visibleRows) {
      this.logger.warn(`TikTok Studio analytics detail target counts: ${JSON.stringify(counts)}`);
    }

    const limit = Math.min(postIds.length, maxDetails);
    this.logger.log(
      `TikTok Studio opening analytics details: visibleRows=${visibleRows} limit=${limit}`,
    );
    if (!limit || !visibleRows) {
      await onProgress?.({
        message: 'Không tìm thấy nút/trang phân tích video trong TikTok Studio',
        progress: 50,
        context: { ...counts, visibleRows, detailLimit: limit },
      });
      return;
    }
    await onProgress?.({
      message: `Tìm thấy ${visibleRows} dòng đang hiển thị, sẽ mở tối đa ${limit} chi tiết`,
      progress: 50,
      totalItems: limit,
      context: { ...counts, visibleRows, detailLimit: limit },
    });

    for (let index = 0; index < limit; index++) {
      try {
        if (index > 0) {
          await this.scrollPostTableToIndex(page, index);
          await page.waitForTimeout(1_000);
          counts = await this.countAnalyticsDetailTargets(page, maxDetails);
        }
        await onProgress?.({
          message: `Đang mở chi tiết analytics ${index + 1}/${limit}`,
          progress: Math.round(50 + (index / Math.max(limit, 1)) * 25),
          processedItems: index,
          totalItems: limit,
        });
        const clicked = await this.clickAnalyticsDetailButton(page, 0);
        if (!clicked) {
          const currentCounts = await this.countAnalyticsDetailTargets(page, maxDetails);
          const videoId = postIds[index];
          this.logger.warn(`TikTok Studio analytics detail button not clickable at index=${index}`);
          await onProgress?.({
            message: `Không click được nút phân tích video ${index + 1}/${limit}`,
            progress: Math.round(50 + (index / Math.max(limit, 1)) * 25),
            processedItems: index,
            totalItems: limit,
            context: { videoId, index, url: page.url(), ...currentCounts },
          });
          continue;
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => undefined);
        await page.waitForTimeout(5_000);
        await this.autoScroll(page);
        const videoId = postIds[index];
        await this.scrapeAnalyticsTabs(page, videoId, metrics).catch((error) => {
          this.logger.warn(
            `TikTok Studio tab scrape failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        const scrapedMetric = videoId ? metrics.get(videoId) : undefined;
        const scrapedFields = scrapedMetric
          ? Object.entries(scrapedMetric).filter(([, value]) => value != null).length
          : 0;
        if (videoId) {
          await onProgress?.({
            message: `Đã đọc ${scrapedFields} trường analytics từ 3 tab cho video ${index + 1}/${limit}`,
            progress: Math.round(50 + ((index + 1) / Math.max(limit, 1)) * 25),
            processedItems: index + 1,
            totalItems: limit,
            context: { videoId, scrapedFields },
          });
        }
        await Promise.allSettled(pendingResponses.splice(0));
        this.logger.log(
          `TikTok Studio analytics detail captured: index=${index + 1}/${limit} url=${page.url()}`,
        );
        await onProgress?.({
          message: `Đã scan chi tiết analytics ${index + 1}/${limit}`,
          progress: Math.round(50 + ((index + 1) / Math.max(limit, 1)) * 25),
          processedItems: index + 1,
          totalItems: limit,
        });

        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 })
          .catch(() => undefined);
        await page.waitForTimeout(2_000);
      } catch (error) {
        const videoId = postIds[index];
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`TikTok Studio analytics detail failed at index=${index}: ${message}`);
        await onProgress?.({
          message: `Lỗi khi scan chi tiết analytics video ${index + 1}/${limit}`,
          progress: Math.round(50 + (index / Math.max(limit, 1)) * 25),
          processedItems: index,
          totalItems: limit,
          context: { videoId, index, url: page.url(), error: message },
        });
      }
    }
  }

  private async clickAnalyticsDetailButton(page: Page, index: number): Promise<boolean> {
    const row = this.analyticsVideoRows(page).nth(index);
    if (await row.count().catch(() => 0)) {
      await row.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
      await row.hover({ timeout: 10_000 }).catch(() => undefined);
      const rowActionBars = row.locator('[data-tt="components_ActionCell_FlexRow_7"]');
      if (await rowActionBars.count().catch(() => 0)) {
        const analystButton = rowActionBars.first().locator('.Tooltip__root').nth(1);
        if (await analystButton.count().catch(() => 0)) {
          await analystButton.click({ timeout: 10_000 });
          return true;
        }
      }
      const rowActions = row.locator('[data-tt="components_ActionCell_Container"]');
      if ((await rowActions.count().catch(() => 0)) >= 2) {
        await rowActions.nth(1).click({ timeout: 10_000 });
        return true;
      }
    }

    for (const locator of this.analyticsDetailTargetLocators(page, index)) {
      if (!(await locator.count().catch(() => 0))) continue;
      await locator.first().scrollIntoViewIfNeeded({ timeout: 10_000 });
      await locator.first().click({ timeout: 10_000 });
      return true;
    }
    return false;
  }

  private async scrollPostTableToIndex(page: Page, index: number): Promise<void> {
    const container = page.locator('[data-tt="components_PostTable_Container"]').first();
    if (!(await container.count().catch(() => 0))) {
      await page.mouse.wheel(0, index * 120);
      return;
    }
    await container.evaluate((element, rowIndex) => {
      const rowHeight = 100;
      element.scrollTop = rowIndex * rowHeight;
    }, index);
  }

  private analyticsDetailTargetLocators(page: Page, index: number): ReturnType<Page['locator']>[] {
    const labeledButtonSelector = [
      'button[aria-label*="phân tích" i]',
      'button[title*="phân tích" i]',
      '[role="button"][aria-label*="phân tích" i]',
      '[role="button"][title*="phân tích" i]',
      'button[aria-label*="analytics" i]',
      'button[title*="analytics" i]',
      '[role="button"][aria-label*="analytics" i]',
      '[role="button"][title*="analytics" i]',
    ].join(',');
    const row = this.analyticsVideoRows(page).nth(index);
    return [
      row.locator('[data-tt="components_ActionCell_FlexRow_7"] .Tooltip__root').nth(1),
      page.locator('[data-tt="components_ActionCell_FlexRow_7"] .Tooltip__root').nth(index * 4 + 1),
      page.locator('[data-tt="components_ActionCell_Container"]').nth(index * 4 + 1),
      page
        .locator('span[data-testid="ChartRise"], span[data-icon="ChartRise"]')
        .locator('xpath=ancestor::div[@cursor="pointer"][1]')
        .nth(index),
      page
        .locator('svg[data-icon="chart-rise"]')
        .locator('xpath=ancestor::div[@cursor="pointer"][1]')
        .nth(index),
      page.locator(`xpath=${this.analyticsDetailButtonXPath(index)}`),
      page.locator(`xpath=${this.analyticsDetailButtonSoftXPath(index)}`),
      page.locator(labeledButtonSelector).nth(index),
      page
        .locator('button:has-text("Phân tích"), [role="button"]:has-text("Phân tích")')
        .nth(index),
      page
        .locator('button:has-text("Analytics"), [role="button"]:has-text("Analytics")')
        .nth(index),
      row.locator('button:has-text("Phân tích"), [role="button"]:has-text("Phân tích")').first(),
      row.locator('button:has-text("Analytics"), [role="button"]:has-text("Analytics")').first(),
      row.locator('button, [role="button"], a').last(),
    ];
  }

  private analyticsVideoRows(page: Page): ReturnType<Page['locator']> {
    return page
      .locator(
        '[data-tt="components_VideoTable_Row"], [data-tt*="VideoTable"][data-tt*="Row"], tbody tr, [role="row"]',
      )
      .filter({
        has: page.locator(
          '[data-tt="components_ActionCell_FlexRow_7"], [data-tt="components_ActionCell_Container"]',
        ),
      });
  }

  private async scrapeAnalyticsTabs(
    page: Page,
    videoId: string | undefined,
    output: Map<string, TikTokAnalyticsMetric>,
  ): Promise<void> {
    if (!videoId) {
      this.logger.warn(`TikTok Studio tab scrape skipped: missing video id for ${page.url()}`);
      return;
    }

    const overviewText = await this.visibleText(page);
    const overview = {
      ...this.parseOverviewTab(overviewText),
      ...(await this.scrapeOverviewInfoCard(page)),
    };

    const viewersClicked = await this.clickTab(page, ['Người xem', 'Viewers']);
    const viewersText = viewersClicked ? await this.visibleText(page) : '';
    const viewers = viewersText
      ? {
          ...this.parseViewersTab(viewersText),
          ...(await this.scrapeViewersTabDom(page)),
        }
      : {};

    const interactionClicked = await this.clickTab(page, [
      'Tương tác',
      'Interaction',
      'Engagement',
    ]);
    const interactionText = interactionClicked ? await this.visibleText(page) : '';
    const interaction = interactionText ? this.parseInteractionTab(interactionText) : {};

    const current = output.get(videoId) ?? {};
    output.set(videoId, {
      ...current,
      ...overview,
      ...viewers,
      ...interaction,
      rawTabs: {
        overview: this.compactText(overviewText),
        viewers: this.compactText(viewersText),
        interaction: this.compactText(interactionText),
      },
    });
    this.logger.log(
      `TikTok Studio tabs scraped for ${videoId}: ` +
        `overview=${Object.keys(overview).length} viewers=${Object.keys(viewers).length} interaction=${Object.keys(interaction).length}`,
    );
  }

  private async clickTab(page: Page, names: string[]): Promise<boolean> {
    for (const name of names) {
      const tab = page.getByText(name, { exact: true }).first();
      if (!(await tab.count().catch(() => 0))) continue;
      await tab.click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
      await this.autoScroll(page);
      return true;
    }
    return false;
  }

  private async visibleText(page: Page): Promise<string> {
    return page.locator('body').innerText({ timeout: 10_000 });
  }

  private async scrapeOverviewInfoCard(page: Page): Promise<Partial<TikTokAnalyticsMetric>> {
    const values = await page
      .locator(
        '[data-tt="VideoOverviewPage_VideoInfoCard_FlexColumn"] [data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]',
      )
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? '').filter(Boolean))
      .catch(() => [] as string[]);
    if (values.length < 5) return {};
    return {
      views: this.parseCompactNumber(values[0]),
      likes: this.parseCompactNumber(values[1]),
      comments: this.parseCompactNumber(values[2]),
      shares: this.parseCompactNumber(values[3]),
      saves: this.parseCompactNumber(values[4]),
    };
  }

  private parseOverviewTab(text: string): Partial<TikTokAnalyticsMetric> {
    const trafficSources = this.parseBreakdownAfterTitle(text, 'Nguồn lưu lượng truy cập');
    const primaryTraffic = trafficSources[0];
    return {
      viewers: this.parseNumberAfterLabel(text, ['Tổng số người xem', 'Người xem']),
      totalWatchTimeSeconds: this.parseDurationAfterLabel(text, ['Tổng thời gian phát']),
      averageWatchTimeSeconds: this.parseSecondsAfterLabel(text, ['Thời gian xem trung bình']),
      completionRate: this.parsePercentAfterLabel(text, ['Đã xem hết video', 'Tỷ lệ xem hết']),
      newFollowers: this.parseNumberAfterLabel(text, ['Follower mới', 'Follow mới']),
      trafficSource: primaryTraffic ? `${primaryTraffic.label} ${primaryTraffic.value}` : undefined,
      trafficSources,
    };
  }

  private parseViewersTab(text: string): Partial<TikTokAnalyticsMetric> {
    const ageGroups = this.parseBreakdownAfterTitle(text, 'Tuổi');
    const locations = this.parseBreakdownAfterTitle(text, 'Vị trí');
    const topAge = ageGroups[0];
    const topLocation = locations[0];
    return {
      viewers: this.parseNumberAfterLabel(text, ['Tổng số người xem']),
      newViewerRate: this.parsePercentNearLabel(text, ['Người xem mới']),
      returningViewerRate: this.parsePercentNearLabel(text, ['Người xem quay lại']),
      maleRate: this.parsePercentNearLabel(text, ['Nam']),
      femaleRate: this.parsePercentNearLabel(text, ['Nữ']),
      otherGenderRate: this.parsePercentNearLabel(text, ['Khác']),
      mainAgeGroup: topAge ? `${topAge.label} ${topAge.value}` : undefined,
      ageGroups,
      mainLocation: topLocation ? `${topLocation.label} ${topLocation.value}` : undefined,
      locations,
    };
  }

  private async scrapeViewersTabDom(page: Page): Promise<Partial<TikTokAnalyticsMetric>> {
    const result: Partial<TikTokAnalyticsMetric> = {};
    const totalViewersText = await page
      .locator(
        '[data-tt="VideoViewerPage_VideoViewCard_FlexColumn"] [data-tt="VideoViewerPage_VideoViewCard_TUXText"]',
      )
      .nth(1)
      .textContent({ timeout: 5_000 })
      .catch(() => null);
    if (totalViewersText)
      result.viewers = this.parseCompactNumber(totalViewersText) ?? result.viewers;

    const viewerTypePercents = await page
      .locator(
        '[data-tt="components_SingleBarChart_FlexColumn"] [data-tt="components_SingleBarChart_TUXText"]',
      )
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? '').filter(Boolean))
      .catch(() => [] as string[]);
    if (viewerTypePercents.length >= 2) {
      result.newViewerRate = this.parsePercentToken(viewerTypePercents[0]) ?? result.newViewerRate;
      result.returningViewerRate =
        this.parsePercentToken(viewerTypePercents[1]) ?? result.returningViewerRate;
    }
    if (viewerTypePercents.length >= 4) {
      result.nonFollowerRate =
        this.parsePercentToken(viewerTypePercents[2]) ?? result.nonFollowerRate;
      result.followerRate = this.parsePercentToken(viewerTypePercents[3]) ?? result.followerRate;
    }

    const genderRows = await page
      .locator('.semi-ring-distribution-labels')
      .evaluateAll((rows) =>
        rows
          .map((row) =>
            Array.from(row.querySelectorAll('span'))
              .map((span) => span.textContent?.trim() ?? '')
              .filter(Boolean),
          )
          .filter((items) => items.length >= 2),
      )
      .catch(() => [] as string[][]);
    for (const row of genderRows) {
      const label = row[0];
      const value = this.parsePercentToken(row[row.length - 1]);
      if (value == null) continue;
      if (label === 'Nam') result.maleRate = value;
      if (label === 'Nữ') result.femaleRate = value;
      if (label === 'Khác') result.otherGenderRate = value;
    }

    const ageGroups = await this.scrapeBarListAfterTitle(page, 'Tuổi');
    if (ageGroups.length) {
      result.ageGroups = ageGroups;
      result.mainAgeGroup = `${ageGroups[0].label} ${ageGroups[0].value}`;
    }

    const locations = await this.scrapeBarListAfterTitle(page, 'Vị trí');
    if (locations.length) {
      result.locations = locations;
      result.mainLocation = `${locations[0].label} ${locations[0].value}`;
    }

    return result;
  }

  private async scrapeBarListAfterTitle(
    page: Page,
    title: string,
  ): Promise<Array<{ label: string; value: number | string }>> {
    const card = page
      .locator('[data-tt="components_AnalyticsCard_CardWrapper"]')
      .filter({ hasText: title })
      .first();
    if (!(await card.count().catch(() => 0))) return [];
    return card
      .locator('div[cursor="auto"]')
      .evaluateAll((rows) =>
        rows
          .map((row) => {
            const spans = Array.from(row.querySelectorAll('span'))
              .map((span) => span.textContent?.trim() ?? '')
              .filter(Boolean);
            if (spans.length < 2) return null;
            return { label: spans[0], value: spans[spans.length - 1] };
          })
          .filter((item): item is { label: string; value: string } => Boolean(item)),
      )
      .catch(() => [] as Array<{ label: string; value: string }>);
  }

  private parseInteractionTab(text: string): Partial<TikTokAnalyticsMetric> {
    return {
      commentKeywords: this.parseBreakdownAfterTitle(
        text,
        'Từ ngữ được sử dụng nhiều nhất trong bình luận',
      ),
    };
  }

  private parseNumberAfterLabel(text: string, labels: string[]): number | undefined {
    const lines = this.lines(text);
    for (const label of labels) {
      const index = lines.findIndex((line) => line.includes(label));
      if (index < 0) continue;
      for (const line of lines.slice(index + 1, index + 5)) {
        const value = this.parseCompactNumber(line);
        if (value != null) return value;
      }
    }
    return undefined;
  }

  private parsePercentAfterLabel(text: string, labels: string[]): number | undefined {
    const lines = this.lines(text);
    for (const label of labels) {
      const index = lines.findIndex((line) => line.includes(label));
      if (index < 0) continue;
      for (const line of lines.slice(index + 1, index + 5)) {
        const value = this.parsePercentToken(line);
        if (value != null) return value;
      }
    }
    return undefined;
  }

  private parsePercentNearLabel(text: string, labels: string[]): number | undefined {
    const lines = this.lines(text);
    for (const label of labels) {
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].includes(label)) continue;
        const windowText = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
        const value = this.parsePercentToken(windowText);
        if (value != null) return value;
      }
    }
    return undefined;
  }

  private parseDurationAfterLabel(text: string, labels: string[]): number | undefined {
    const lines = this.lines(text);
    for (const label of labels) {
      const index = lines.findIndex((line) => line.includes(label));
      if (index < 0) continue;
      for (const line of lines.slice(index + 1, index + 5)) {
        const value = this.parseDurationToken(line);
        if (value != null) return value;
      }
    }
    return undefined;
  }

  private parseSecondsAfterLabel(text: string, labels: string[]): number | undefined {
    const lines = this.lines(text);
    for (const label of labels) {
      const index = lines.findIndex((line) => line.includes(label));
      if (index < 0) continue;
      for (const line of lines.slice(index + 1, index + 5)) {
        const value = this.parseSecondsToken(line);
        if (value != null) return value;
      }
    }
    return undefined;
  }

  private parseBreakdownAfterTitle(
    text: string,
    title: string,
  ): Array<{ label: string; value: number | string }> {
    const lines = this.lines(text);
    const start = lines.findIndex((line) => line.includes(title));
    if (start < 0) return [];
    const output: Array<{ label: string; value: number | string }> = [];
    const stopTitles = [
      'Tổng quan',
      'Người xem',
      'Tương tác',
      'Giới tính',
      'Vị trí',
      'Tuổi',
      'Loại người xem',
      'Từ ngữ được sử dụng nhiều nhất trong bình luận',
      'Lượt thích',
    ];
    for (let index = start + 1; index < lines.length - 1; index++) {
      const label = lines[index];
      if (stopTitles.some((stop) => stop !== title && label.includes(stop))) {
        if (output.length) break;
        continue;
      }
      const next = lines[index + 1];
      const value = this.parsePercentToken(next) ?? this.parseCompactNumber(next);
      if (value == null || /^\d/.test(label) || label.length > 80) continue;
      output.push({ label, value: typeof next === 'string' && next.includes('<') ? next : value });
      index += 1;
      if (output.length >= 12) break;
    }
    return output;
  }

  private parseCompactNumber(value: string): number | undefined {
    const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
    if (!match) return undefined;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return undefined;
    const suffix = match[2]?.toUpperCase();
    if (suffix === 'K') return Math.round(base * 1_000);
    if (suffix === 'M') return Math.round(base * 1_000_000);
    if (suffix === 'B') return Math.round(base * 1_000_000_000);
    return base;
  }

  private parsePercentToken(value: string): number | undefined {
    const match = value.match(/<?\s*(\d+(?:[.,]\d+)?)\s*%/);
    if (!match) return undefined;
    return Number(match[1].replace(',', '.'));
  }

  private parseDurationToken(value: string): number | undefined {
    const match = value.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/);
    if (!match || !match[0]) return undefined;
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }

  private parseSecondsToken(value: string): number | undefined {
    const match = value.match(/(\d+(?:\.\d+)?)\s*s/);
    if (!match) return undefined;
    return Number(match[1]);
  }

  private lines(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private compactText(text: string): string {
    return this.lines(text).join('\n').slice(0, 10_000);
  }

  private analyticsDetailButtonXPath(index: number): string {
    return `${TIKTOK_ANALYTICS_DETAIL_BUTTON_XPATH_PREFIX}/div[${index + 2}]/div[1]/div[1]`;
  }

  private analyticsDetailButtonSoftXPath(index: number): string {
    return `(//*[contains(@class,'css-1jhq6dt')]/div[position()>1]/div[1]/div[1])[${index + 1}]`;
  }

  private chartRiseButtonXPath(index: number): string {
    return `(//span[@data-testid='ChartRise' or @data-icon='ChartRise' or .//*[name()='svg' and @data-icon='chart-rise']]/ancestor::div[@cursor='pointer'][1])[${index + 1}]`;
  }

  private async countAnalyticsDetailTargets(
    page: Page,
    maxDetails: number,
  ): Promise<Record<string, number>> {
    const actionBars = await page
      .locator('[data-tt="components_ActionCell_FlexRow_7"]')
      .count()
      .catch(() => 0);
    const actionCells = await page
      .locator('[data-tt="components_ActionCell_Container"]')
      .count()
      .catch(() => 0);
    const actionCellGroups = Math.floor(actionCells / 4);
    const actionRows = await this.analyticsVideoRows(page)
      .count()
      .catch(() => 0);
    const chartRiseIcons = await page
      .locator(
        'span[data-testid="ChartRise"], span[data-icon="ChartRise"], svg[data-icon="chart-rise"]',
      )
      .count()
      .catch(() => 0);
    const chartRiseButtons = await page
      .locator(`xpath=${this.chartRiseButtonXPath(0).replace(/\[1\]$/, '')}`)
      .count()
      .catch(() => 0);
    const labeledButtons = await page
      .locator(
        [
          'button[aria-label*="phân tích" i]',
          'button[title*="phân tích" i]',
          '[role="button"][aria-label*="phân tích" i]',
          '[role="button"][title*="phân tích" i]',
          'button[aria-label*="analytics" i]',
          'button[title*="analytics" i]',
          '[role="button"][aria-label*="analytics" i]',
          '[role="button"][title*="analytics" i]',
        ].join(','),
      )
      .count()
      .catch(() => 0);
    const analyticsText = await page
      .locator(
        'button:has-text("Phân tích"), [role="button"]:has-text("Phân tích"), button:has-text("Analytics"), [role="button"]:has-text("Analytics")',
      )
      .count()
      .catch(() => 0);
    const rows = await page
      .locator('tbody tr, [role="row"], [data-e2e*="video" i]')
      .count()
      .catch(() => 0);
    let exactXPath = 0;
    let softXPath = 0;
    for (let index = 0; index < maxDetails; index++) {
      const exactExists = await page
        .locator(`xpath=${this.analyticsDetailButtonXPath(index)}`)
        .count()
        .catch(() => 0);
      if (exactExists) exactXPath += 1;
      const chartRiseExists = await page
        .locator(`xpath=${this.chartRiseButtonXPath(index)}`)
        .count()
        .catch(() => 0);
      const softExists = await page
        .locator(`xpath=${this.analyticsDetailButtonSoftXPath(index)}`)
        .count()
        .catch(() => 0);
      if (softExists) softXPath += 1;
      if (!exactExists && !softExists && !chartRiseExists && index > 3) break;
    }
    return {
      chartRiseIcons,
      chartRiseButtons,
      actionBars,
      actionCells,
      actionCellGroups,
      actionRows,
      labeledButtons,
      analyticsText,
      rows,
      exactXPath,
      softXPath,
    };
  }

  private async launchPersistentContext(
    platformAccountId: string,
    headless: boolean,
  ): Promise<BrowserContext> {
    const channel = this.config.get<string>('PLAYWRIGHT_BROWSER_CHANNEL', 'chrome');
    const profileRoot = resolve(
      this.config.get<string>(
        'PLAYWRIGHT_TIKTOK_PROFILE_DIR',
        './playwright-artifacts/tiktok-studio',
      ),
    );
    const userDataDir = resolve(profileRoot, platformAccountId);
    try {
      await mkdir(userDataDir, { recursive: true });
      this.logger.log(
        `Launching TikTok persistent profile: dir=${userDataDir} headless=${headless} channel=${channel}`,
      );
      return await chromium.launchPersistentContext(userDataDir, {
        headless,
        channel,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        viewport: { width: 1440, height: 1000 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Cannot launch Playwright browser: ${message}`);
      throw new ServiceUnavailableException(
        'Không thể mở trình duyệt profile TikTok. Hãy cài Google Chrome hoặc cấu hình PLAYWRIGHT_BROWSER_CHANNEL / PLAYWRIGHT_TIKTOK_PROFILE_DIR.',
      );
    }
  }

  private shouldRunHeadless(): boolean {
    return this.config.get<string>('PLAYWRIGHT_HEADLESS', 'true') !== 'false';
  }

  connectOAuthAndAnalytics(
    userId: string,
    authUrl: string,
  ): { authUrl: string; studioUrl: string; message: string } {
    this.logger.log(`Preparing TikTok connection for user ${userId}`);
    return {
      authUrl,
      studioUrl: TIKTOK_STUDIO_URL,
      message: 'Hoàn tất OAuth, sau đó kết nối phiên TikTok Studio.',
    };
  }
}
