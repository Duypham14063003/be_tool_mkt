import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
export interface AuditInput { userId?: string; action: string; entityType: string; entityId?: string; oldData?: Prisma.InputJsonValue; newData?: Prisma.InputJsonValue; ipAddress?: string; userAgent?: string }
@Injectable() export class AuditLogsService { constructor(private prisma:PrismaService){} record(input:AuditInput){return this.prisma.auditLog.create({data:{...input,userId:input.userId??null,entityId:input.entityId??null,oldData:input.oldData??undefined,newData:input.newData??undefined}})} }
