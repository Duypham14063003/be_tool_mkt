import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Platform, Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CreateKpiDto, UpdateKpiDto } from './dto';
import { KpisService } from './kpis.service';

@ApiTags('kpis') @ApiBearerAuth() @UseGuards(AuthGuard('jwt'), RolesGuard) @Controller('kpis')
export class KpisController {
  constructor(private service: KpisService) { }
  @Get() list(@CurrentUser() user: AuthUser, @Query('platform') platform?: Platform) { return this.service.list(user, platform); }
  @Post() @Roles(Role.ADMIN, Role.MARKETING) create(@Body() dto: CreateKpiDto, @CurrentUser() user: AuthUser) { return this.service.create(dto, user); }
  @Get('performance') performance(@CurrentUser() user: AuthUser, @Query('platform') platform?: Platform) { return this.service.performance(user, platform); }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.service.get(id, user); }
  @Patch(':id') @Roles(Role.ADMIN, Role.MARKETING) update(@Param('id') id: string, @Body() dto: UpdateKpiDto, @CurrentUser() user: AuthUser) { return this.service.update(id, dto, user); }
  @Delete(':id') @Roles(Role.ADMIN, Role.MARKETING) remove(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.service.remove(id, user); }
}
