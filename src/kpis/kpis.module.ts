import { Global, Module } from '@nestjs/common';
import { RolesGuard } from '../common/roles.guard';
import { KpiCalculatorService } from './kpi-calculator.service';
import { KpisController } from './kpis.controller';
import { KpisService } from './kpis.service';
@Global()
@Module({ controllers: [KpisController], providers: [KpiCalculatorService, KpisService, RolesGuard], exports: [KpiCalculatorService, KpisService] })
export class KpisModule { }
