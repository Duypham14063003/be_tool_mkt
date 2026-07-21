import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { CreateSyncDto } from './dto';
import { SyncService } from './sync.service';
@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('sync')
export class SyncController {
  constructor(private s: SyncService) {}
  @Post() create(@Body() d: CreateSyncDto, @CurrentUser() u: AuthUser) {
    return this.s.create(d, u);
  }
  @Post('facebook') fb(@Body() d: CreateSyncDto, @CurrentUser() u: AuthUser) {
    return this.s.create(d, u);
  }
  @Post('tiktok') tt(@Body() d: CreateSyncDto, @CurrentUser() u: AuthUser) {
    return this.s.create(d, u);
  }
  @Post('platform-accounts/:id') account(
    @Param('id') id: string,
    @Body() d: CreateSyncDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.s.create({ ...d, platformAccountId: id }, u);
  }
  @Get('jobs') list(@CurrentUser() u: AuthUser) {
    return this.s.list(u);
  }
  @Get('jobs/:id') get(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.s.get(id, u);
  }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.s.cancel(id, u);
  }
}
