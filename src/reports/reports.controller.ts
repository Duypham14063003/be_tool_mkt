import { Body, Controller, Get, Param, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import { basename } from 'path';
import type { Response } from 'express';
import { AuthUser } from '../common/auth.types'; import { CurrentUser } from '../common/current-user.decorator'; import { CreateReportDto } from './dto'; import { ReportsService } from './reports.service';
@ApiTags('reports') @ApiBearerAuth() @UseGuards(AuthGuard('jwt')) @Controller('reports')
export class ReportsController { constructor(private service: ReportsService) {} @Post() create(@Body() dto: CreateReportDto,@CurrentUser() user:AuthUser){return this.service.create(dto,user)} @Get()list(@CurrentUser()user:AuthUser){return this.service.list(user)} @Get(':id')get(@Param('id')id:string,@CurrentUser()user:AuthUser){return this.service.get(id,user)} @Get(':id/download')async download(@Param('id')id:string,@CurrentUser()user:AuthUser,@Res({passthrough:true})response:Response){const report=await this.service.download(id,user);response.setHeader('Content-Disposition',`attachment; filename="${basename(report.filePath!)}"`);response.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return new StreamableFile(createReadStream(report.filePath!))} }
