import { Platform } from '@prisma/client';
export interface NormalizedMetric { views: bigint|null; reach: bigint|null; viewers: bigint|null; reactions: bigint|null; likes: bigint|null; comments: bigint|null; shares: bigint|null; saves: bigint|null; view3Seconds: bigint|null; view1Minute: bigint|null; engagementRate: number|null; rawData: Record<string, unknown> }
export interface NormalizedPost { externalPostId:string; platform:Platform; contentType:string; caption:string|null; postUrl:string|null; thumbnailUrl:string|null; durationSeconds:number|null; publishedAt:Date; rawData:Record<string,unknown>; metric:NormalizedMetric }
export interface SocialProvider { getPosts(accountId:string, from:Date, to:Date):Promise<NormalizedPost[]> }
