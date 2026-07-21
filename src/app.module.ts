import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { KpisModule } from './kpis/kpis.module';
import { PlatformAccountsModule } from './platform-accounts/platform-accounts.module';
import { PostsModule } from './posts/posts.module';
import { ReportsModule } from './reports/reports.module';
import { SyncModule } from './sync/sync.module';
@Module({ imports: [ConfigModule.forRoot({isGlobal:true}),ThrottlerModule.forRoot([{ttl:60000,limit:100}]),BullModule.forRootAsync({inject:[ConfigService],useFactory:(c:ConfigService)=>({connection:{host:c.get('REDIS_HOST','localhost'),port:c.get<number>('REDIS_PORT',6379)}})}),DatabaseModule,CommonModule,AuditLogsModule,KpisModule,AuthModule,PlatformAccountsModule,SyncModule,PostsModule,DashboardModule,ReportsModule,HealthModule], providers:[{provide:APP_GUARD,useClass:ThrottlerGuard}] })
export class AppModule implements NestModule { configure(consumer: MiddlewareConsumer): void { consumer.apply(CorrelationIdMiddleware).forRoutes('*'); } }
