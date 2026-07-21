import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { KpiCalculatorService } from '../../kpis/kpi-calculator.service';
import { NormalizedMetric, NormalizedPost, SocialProvider } from '../social-provider';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const POST_INSIGHT_METRICS = [
  'post_impressions_unique',// Reach
  'post_video_views',          // Lượt xem video
  'post_video_views_3s',       // Xem từ 3 giây
  'post_video_complete_views', // Xem hết
].join(',');
const VIDEO_INSIGHT_METRICS = [
  'post_video_views_60s_excludes_shorter',
].join(',');
interface FbPost {
  id: string;
  message?: string;
  story?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: {
    data: Array<{ type: string; description?: string }>;
  };
  reactions?: { summary: { total_count: number } };
  comments?: { summary: { total_count: number } };
  shares?: { count: number };
}
interface FbInsightValue {
  value: number;
  end_time?: string;
}
interface FbInsight {
  name: string;
  values: FbInsightValue[];
}
@Injectable()
export class FacebookProvider implements SocialProvider {
  private readonly logger = new Logger(FacebookProvider.name);
  constructor(
    private readonly config: ConfigService,
    private readonly calc: KpiCalculatorService,
  ) {}
  private async graphGet<T>(
    path: string,
    params: Record<string, string>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${GRAPH_BASE}${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`Facebook API error: ${JSON.stringify(json.error)}`);
    }
    return json as T;
  }
  async getPageAccessToken(userToken: string): Promise<{ id: string; name: string; access_token: string }[]> {
    const data = await this.graphGet<{ data: Array<{ id: string; name: string; access_token: string }> }>(
      '/me/accounts',
      { fields: 'id,name,access_token' },
      userToken,
    );
    return data.data ?? [];
  }
  async getPosts(
    externalAccountId: string,
    from: Date,
    to: Date,
    accessToken: string,
  ): Promise<NormalizedPost[]> {
    this.logger.log(`Fetching Facebook posts for page ${externalAccountId} from ${from.toISOString()} to ${to.toISOString()}`);
    const pageToken = accessToken;
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);
    let posts: FbPost[] = [];
    let nextUrl: string | null = null;
    const firstBatch = await this.graphGet<{ data: FbPost[]; paging?: { next?: string } }>(
      `/${externalAccountId}/posts`,
      {
        fields: 'id,message,story,created_time,permalink_url,full_picture,attachments{type,description},reactions.summary(true),comments.summary(true),shares',
        since: fromTs.toString(),
        until: toTs.toString(),
        limit: '100',
      },
      pageToken,
    );
    posts = firstBatch.data ?? [];
    nextUrl = firstBatch.paging?.next ?? null;
    while (nextUrl) {
      const res = await fetch(nextUrl);
      const batch = await res.json() as { data: FbPost[]; paging?: { next?: string } };
      posts = posts.concat(batch.data ?? []);
      nextUrl = batch.paging?.next ?? null;
    }
    this.logger.log(`Got ${posts.length} posts from Facebook`);
    const normalized: NormalizedPost[] = [];
    for (const post of posts) {
      try {
        const norm = await this.normalizePost(post, pageToken);
        normalized.push(norm);
      } catch (err) {
        this.logger.warn(`Skipping post ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return normalized;
  }

  private async normalizePost(post: FbPost, pageToken: string): Promise<NormalizedPost> {
    const attachType = post.attachments?.data?.[0]?.type ?? '';
    const isVideo = ['video_inline', 'video', 'native_templates'].includes(attachType);
    let reach = 0;
    let videoViews = 0;
    let view3s = 0;
    let view1min = 0;

    try {
      const insightRes = await this.graphGet<{ data: FbInsight[] }>(
        `/${post.id}/insights`,
        {
          metric: isVideo
            ? `${POST_INSIGHT_METRICS},${VIDEO_INSIGHT_METRICS}`
            : 'post_impressions_unique',
          period: 'lifetime',
        },
        pageToken,
      );

      for (const metric of insightRes.data ?? []) {
        const val = metric.values?.[0]?.value ?? 0;
        switch (metric.name) {
          case 'post_impressions_unique': reach = val; break;
          case 'post_video_views': videoViews = val; break;
          case 'post_video_views_3s': view3s = val; break;
          case 'post_video_views_60s_excludes_shorter': view1min = val; break;
        }
      }
    } catch (insightErr) {
      this.logger.warn(`Could not fetch insights for ${post.id}: ${insightErr instanceof Error ? insightErr.message : String(insightErr)}`);
    }

    const reactions = post.reactions?.summary?.total_count ?? 0;
    const comments = post.comments?.summary?.total_count ?? 0;
    const shares = post.shares?.count ?? 0;

    const engagementRate = this.calc.facebookEngagement(reactions, comments, shares, reach);

    const caption = post.message ?? post.story ?? post.attachments?.data?.[0]?.description ?? null;

    const metric: NormalizedMetric = {
      views: isVideo ? BigInt(videoViews) : null,
      reach: BigInt(reach),
      viewers: null,
      reactions: BigInt(reactions),
      likes: null,
      comments: BigInt(comments),
      shares: BigInt(shares),
      saves: null,
      view3Seconds: isVideo ? BigInt(view3s) : null,
      view1Minute: isVideo ? BigInt(view1min) : null,
      engagementRate,
      rawData: { post_id: post.id, reactions, comments, shares, reach, videoViews, view3s, view1min },
    };

    return {
      externalPostId: post.id,
      platform: Platform.FACEBOOK,
      contentType: isVideo ? 'VIDEO' : 'POST',
      caption,
      postUrl: post.permalink_url ?? null,
      thumbnailUrl: post.full_picture ?? null,
      durationSeconds: null,
      publishedAt: new Date(post.created_time),
      rawData: { source: 'facebook_graph_api', originalType: attachType },
      metric,
    };
  }
}
