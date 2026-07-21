import { Platform, PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
  const admin = await prisma.user.upsert({ where: { email: 'admin@example.com' }, update: {}, create: { name: 'Admin', email: 'admin@example.com', passwordHash: await argon2.hash(process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!'), role: Role.ADMIN } });
  const marketing = await prisma.user.upsert({ where: { email: 'marketing@example.com' }, update: {}, create: { name: 'Marketing', email: 'marketing@example.com', passwordHash: await argon2.hash(process.env.SEED_MARKETING_PASSWORD ?? 'Marketing123!'), role: Role.MARKETING } });
  const accounts = await Promise.all([
    prisma.platformAccount.upsert({ where: { platform_externalAccountId_userId: { platform: Platform.FACEBOOK, externalAccountId: 'fake-facebook-page', userId: marketing.id } }, update: {}, create: { userId: marketing.id, platform: Platform.FACEBOOK, accountName: 'Facebook Demo', externalAccountId: 'fake-facebook-page', connectionStatus: 'CONNECTED', metadata: { developmentOnly: true } } }),
    prisma.platformAccount.upsert({ where: { platform_externalAccountId_userId: { platform: Platform.TIKTOK, externalAccountId: 'fake-tiktok-account', userId: marketing.id } }, update: {}, create: { userId: marketing.id, platform: Platform.TIKTOK, accountName: 'TikTok Demo', externalAccountId: 'fake-tiktok-account', connectionStatus: 'CONNECTED', metadata: { developmentOnly: true } } }),
  ]);
  for (const account of accounts) for (let index = 0; index < 10; index++) {
    const publishedAt = new Date(Date.now() - index * 86_400_000);
    const post = await prisma.post.upsert({ where: { platformAccountId_externalPostId: { platformAccountId: account.id, externalPostId: `seed-${account.platform.toLowerCase()}-${index + 1}` } }, update: {}, create: { platformAccountId: account.id, externalPostId: `seed-${account.platform.toLowerCase()}-${index + 1}`, platform: account.platform, contentType: 'VIDEO', caption: `Development ${account.platform} post ${index + 1}`, durationSeconds: 30 + index, publishedAt, rawData: { provider: 'SEED' } } });
    const views = BigInt(1_000 + index * 100), reach = account.platform === Platform.FACEBOOK ? BigInt(800 + index * 80) : null, likes = BigInt(50 + index), comments = BigInt(10 + index), shares = BigInt(5 + index), saves = account.platform === Platform.TIKTOK ? BigInt(3 + index) : null;
    const engagement = account.platform === Platform.FACEBOOK ? Number(likes + comments + shares) / Number(reach) * 100 : Number(likes + comments + shares + (saves ?? 0n)) / Number(views) * 100;
    await prisma.postMetric.upsert({ where: { postId_metricDate: { postId: post.id, metricDate: publishedAt } }, update: {}, create: { postId: post.id, metricDate: publishedAt, views, reach, reactions: account.platform === Platform.FACEBOOK ? likes : null, likes, comments, shares, saves, viewers: null, engagementRate: engagement, rawData: { sources: { views: 'SEED', likes: 'SEED' } } } });
  }
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const existing = await prisma.kpi.findFirst({ where: { createdBy: admin.id, platform: Platform.FACEBOOK, periodStart: start, metricName: 'views' } });
  if (!existing) await prisma.kpi.create({ data: { platform: Platform.FACEBOOK, periodType: 'MONTHLY', periodStart: start, periodEnd: end, metricName: 'views', targetValue: 15_000, createdBy: admin.id } });
}

main().finally(() => prisma.$disconnect());
