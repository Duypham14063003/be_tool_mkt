import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { KpiCalculatorService } from '../../kpis/kpi-calculator.service';
import { NormalizedMetric, NormalizedPost, SocialProvider } from '../social-provider';

const TIKTOK_BASE = 'https://open.tiktokapis.com';

const VIDEO_FIELDS = [
  'id',
  'title',
  'video_description',
  'create_time',
  'share_url',
  'cover_image_url',
  'duration',
  'view_count',           // Lượt xem
  'unique_video_views',   // Người xem (unique)
  'like_count',           // Like
  'comment_count',        // Bình luận
  'share_count',          // Chia sẻ
  'save_count',           // Lưu video
  'average_time_watched', // Thời gian xem TB (giây)
  'total_time_watched',   // Tổng thời gian xem (giây)
  'video_completion_rate', // Tỷ lệ xem hết (%)
  'followers_count',       // Follow mới (tính từ video)
  'reach_type',           // Nguồn chính
  'new_followers_count',  // Follow mới
  'audience_demographics', // Nam/Nữ, Độ tuổi, Khu vực
].join(',');

interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  share_url?: string;
  cover_image_url?: string;
  duration?: number;
  view_count?: number;
  unique_video_views?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  save_count?: number;
  average_time_watched?: number;
  total_time_watched?: number;
  video_completion_rate?: number;
  new_followers_count?: number;
  audience_demographics?: {
    genders?: Array<{ gender: string; percentage: number }>;
    ages?: Array<{ age_group: string; percentage: number }>;
    countries?: Array<{ country: string; percentage: number }>;
  };
}

interface TikTokListResponse {
  data?: {
    videos?: TikTokVideo[];
    cursor?: number;
    has_more?: boolean;
  };
  error?: {
    code: string;
    message: string;
    log_id?: string;
  };
}

@Injectable()
export class TiktokProvider implements SocialProvider {
  private readonly logger = new Logger(TiktokProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly calc: KpiCalculatorService,
  ) {}

  private async tiktokPost<T>(endpoint: string, body: unknown, accessToken: string): Promise<T> {
    const url = `${TIKTOK_BASE}${endpoint}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { data?: T; error?: { code: string; message: string } };
    if (json.error?.code && json.error.code !== 'ok') {
      throw new Error(`TikTok API error [${json.error.code}]: ${json.error.message}`);
    }
    return json as T;
  }

  // ─── Main: lấy danh sách video theo khoảng ngày ────────────────────────────
  async getPosts(
    _externalAccountId: string,
    from: Date,
    to: Date,
    accessToken: string,
  ): Promise<NormalizedPost[]> {
    this.logger.log(`Fetching TikTok videos from ${from.toISOString()} to ${to.toISOString()}`);

    const videos: TikTokVideo[] = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await this.tiktokPost<TikTokListResponse>(
        '/v2/video/list/',
        {
          fields: VIDEO_FIELDS,
          max_count: 20,
          cursor,
        },
        accessToken,
      );

      const batch = (res as TikTokListResponse).data?.videos ?? [];
      const fetchedCursor = (res as TikTokListResponse).data?.cursor ?? 0;
      const fetchedHasMore = (res as TikTokListResponse).data?.has_more ?? false;

      // Lọc theo khoảng ngày
      const filtered = batch.filter((v) => {
        if (!v.create_time) return true;
        const created = new Date(v.create_time * 1000);
        return created >= from && created <= to;
      });
      videos.push(...filtered);

      // Nếu batch có video cũ hơn from → dừng
      const oldestInBatch = batch.find((v) => v.create_time && new Date(v.create_time * 1000) < from);
      if (oldestInBatch || !fetchedHasMore || batch.length === 0) {
        hasMore = false;
      } else {
        cursor = fetchedCursor;
      }
    }

    this.logger.log(`Got ${videos.length} TikTok videos in date range`);

    // Bước 2: lấy chi tiết statistics bổ sung nếu cần
    const normalized: NormalizedPost[] = [];
    const chunkSize = 20;
    for (let i = 0; i < videos.length; i += chunkSize) {
      const chunk = videos.slice(i, i + chunkSize);
      const ids = chunk.map((v) => v.id).filter(Boolean);

      let detailMap: Map<string, TikTokVideo> = new Map();
      try {
        const detailRes = await this.tiktokPost<TikTokListResponse>(
          '/v2/video/query/',
          { filters: { video_ids: ids }, fields: VIDEO_FIELDS },
          accessToken,
        );
        const details = (detailRes as TikTokListResponse).data?.videos ?? [];
        detailMap = new Map(details.map((v) => [v.id, v]));
      } catch (e) {
        this.logger.warn(`video/query failed, using list data: ${e instanceof Error ? e.message : String(e)}`);
      }

      for (const video of chunk) {
        const detail = detailMap.get(video.id) ?? video;
        normalized.push(this.normalizeVideo(detail));
      }
    }

    return normalized;
  }

  private normalizeVideo(v: TikTokVideo): NormalizedPost {
    const views = v.view_count ?? 0;
    const likes = v.like_count ?? 0;
    const comments = v.comment_count ?? 0;
    const shares = v.share_count ?? 0;
    const saves = v.save_count ?? 0;

    const engagementRate = this.calc.tiktokEngagement(likes, comments, shares, saves, views);

    // Phân tích demographics
    const genders = v.audience_demographics?.genders ?? [];
    const maleEntry = genders.find((g) => g.gender === 'MALE');
    const femaleEntry = genders.find((g) => g.gender === 'FEMALE');
    const maleRate = maleEntry ? maleEntry.percentage : null;
    const femaleRate = femaleEntry ? femaleEntry.percentage : null;

    // Độ tuổi chính (nhóm cao nhất)
    const ages = v.audience_demographics?.ages ?? [];
    const topAge = ages.sort((a, b) => b.percentage - a.percentage)[0];
    const mainAgeGroup = topAge?.age_group ?? null;

    // Khu vực chính
    const countries = v.audience_demographics?.countries ?? [];
    const topCountry = countries.sort((a, b) => b.percentage - a.percentage)[0];
    const mainLocation = topCountry?.country ?? null;

    const caption = v.video_description ?? v.title ?? null;

    const metric: NormalizedMetric = {
      views: BigInt(views),
      reach: null,
      viewers: v.unique_video_views != null ? BigInt(v.unique_video_views) : null,
      reactions: null,
      likes: BigInt(likes),
      comments: BigInt(comments),
      shares: BigInt(shares),
      saves: BigInt(saves),
      view3Seconds: null,
      view1Minute: null,
      engagementRate,
      rawData: {
        source: 'tiktok_content_api',
        total_time_watched: v.total_time_watched,
        average_time_watched: v.average_time_watched,
        video_completion_rate: v.video_completion_rate,
        new_followers_count: v.new_followers_count,
        demographics: v.audience_demographics,
      },
    };

    // Gắn các trường mở rộng vào rawData (sẽ đọc ra ở service để update PostMetric)
    const extendedFields = {
      totalWatchTimeSeconds: v.total_time_watched != null ? v.total_time_watched : null,
      averageWatchTimeSeconds: v.average_time_watched != null ? v.average_time_watched : null,
      completionRate: v.video_completion_rate != null ? v.video_completion_rate : null,
      newFollowers: v.new_followers_count != null ? BigInt(v.new_followers_count) : null,
      maleRate,
      femaleRate,
      mainAgeGroup,
      mainLocation,
      // TikTok không expose traffic source qua Content API v2 tự do → null
      trafficSource: null as string | null,
    };

    // Đính vào metric.rawData để SyncProcessor có thể dùng
    (metric.rawData as Record<string, unknown>)['_extended'] = extendedFields;

    return {
      externalPostId: v.id,
      platform: Platform.TIKTOK,
      contentType: 'VIDEO',
      caption,
      postUrl: v.share_url ?? null,
      thumbnailUrl: v.cover_image_url ?? null,
      durationSeconds: v.duration ?? null,
      publishedAt: v.create_time ? new Date(v.create_time * 1000) : new Date(),
      rawData: { source: 'tiktok_content_api' },
      metric,
    };
  }
}
