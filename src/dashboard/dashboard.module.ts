import { Module } from '@nestjs/common';
import { KpisModule } from '../kpis/kpis.module';
import { DashboardController } from './dashboard.controller';
@Module({ imports: [KpisModule], controllers: [DashboardController] })
export class DashboardModule {}
