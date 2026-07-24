import { Controller, ForbiddenException, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Platform, Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types'; import { CurrentUser } from '../common/current-user.decorator'; import { PrismaService } from '../database/prisma.service';
@ApiTags('posts') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) @Controller('posts')
export class PostsController {
  constructor(private prisma: PrismaService) {}
  @Get() async list(@CurrentUser() user:AuthUser,@Query('platform')platform?:Platform,@Query('platformAccountId')accountId?:string,@Query('dateFrom')dateFrom?:string,@Query('dateTo')dateTo?:string,@Query('contentType')contentType?:string,@Query('keyword')keyword?:string,@Query('sortOrder')sortOrder:'asc'|'desc'='desc',@Query('page')page='1',@Query('limit')limit='20') {
    const take=Math.min(Math.max(Number(limit)||20,1),100), current=Math.max(Number(page)||1,1);
    const endDate=dateTo?new Date(dateTo):undefined;
    if(endDate)endDate.setUTCHours(23,59,59,999);
    const where:Prisma.PostWhereInput={...(platform?{platform}:{}),...(accountId?{platformAccountId:accountId}:{}),...(contentType?{contentType}:{}),...(keyword?{caption:{contains:keyword,mode:'insensitive'}}:{}),...((dateFrom||dateTo)?{publishedAt:{...(dateFrom?{gte:new Date(dateFrom)}:{}),...(endDate?{lte:endDate}:{})}}:{}),...(user.role===Role.ADMIN?{}:{platformAccount:{userId:user.id}})};
    const[data,total]=await this.prisma.$transaction([this.prisma.post.findMany({where,include:{metrics:{orderBy:{metricDate:'desc'},take:1}},skip:(current-1)*take,take,orderBy:{publishedAt:sortOrder==='asc'?'asc':'desc'}}),this.prisma.post.count({where})]);

    // The legacy endpoint is still consumed by the current frontend. Enrich
    // its metric shape from the new platform-neutral analytics snapshots.
    if (data.length) {
      const socialPosts = await this.prisma.socialPost.findMany({
        where: { externalPostId: { in: data.map((post) => post.externalPostId) } },
        include: {
          analytics: { orderBy: { collectedAt: 'desc' }, take: 1 },
        },
      });
      const analyticsByExternalId = new Map(
        socialPosts.map((post) => [post.externalPostId, post.analytics[0]]),
      );
      for (const post of data) {
        const analytics = analyticsByExternalId.get(post.externalPostId);
        if (!analytics) continue;
        const metric = post.metrics[0];
        if (!metric) continue;
        Object.assign(metric, {
          viewers: analytics.viewers ?? metric.viewers,
          saves: analytics.saves ?? metric.saves,
          totalWatchTimeSeconds: analytics.totalWatchTimeSeconds ?? metric.totalWatchTimeSeconds,
          averageWatchTimeSeconds: analytics.averageWatchTimeSeconds ?? metric.averageWatchTimeSeconds,
          completionRate: analytics.completionRate ?? metric.completionRate,
          newFollowers: analytics.newFollowers ?? metric.newFollowers,
          maleRate: analytics.maleRate ?? metric.maleRate,
          femaleRate: analytics.femaleRate ?? metric.femaleRate,
          mainAgeGroup: analytics.mainAgeGroup ?? metric.mainAgeGroup,
          mainLocation: analytics.mainLocation ?? metric.mainLocation,
          trafficSource: analytics.trafficSource ?? metric.trafficSource,
        });
      }
    }
    return{data,meta:{page:current,limit:take,total,totalPages:Math.ceil(total/take)}};
  }
  @Get(':id') async get(@Param('id')id:string,@CurrentUser()user:AuthUser){return this.assertPost(id,user,true)}
  @Get(':id/metrics') async metrics(@Param('id')id:string,@CurrentUser()user:AuthUser){await this.assertPost(id,user);return this.prisma.postMetric.findMany({where:{postId:id},orderBy:{metricDate:'desc'}})}
  @Get(':id/metric-history') history(@Param('id')id:string,@CurrentUser()user:AuthUser){return this.metrics(id,user)}
  private async assertPost(id:string,user:AuthUser,includeMetrics=false){const row=await this.prisma.post.findFirst({where:{id,...(user.role===Role.ADMIN?{}:{platformAccount:{userId:user.id}})},include:{metrics:includeMetrics}});if(!row)throw new ForbiddenException();return row}
}
