import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { EncryptionService } from '../common/encryption.service';
import { PrismaService } from '../database/prisma.service';
import { CreatePlatformAccountDto, UpdatePlatformAccountDto } from './dto';
const safeSelect = {
  id: true,
  userId: true,
  platform: true,
  accountName: true,
  externalAccountId: true,
  tokenExpiresAt: true,
  connectionStatus: true,
  lastSyncedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class PlatformAccountsService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}
  list(user: AuthUser) {
    return this.prisma.platformAccount.findMany({
      where: user.role === Role.ADMIN ? {} : { userId: user.id },
      select: safeSelect,
    });
  }
  async assertOwned(id: string, user: AuthUser) {
    const row = await this.prisma.platformAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('PLATFORM_ACCOUNT_NOT_FOUND');
    if (user.role !== Role.ADMIN && row.userId !== user.id) throw new ForbiddenException();
    return row;
  }
  async get(id: string, user: AuthUser) {
    await this.assertOwned(id, user);
    return this.prisma.platformAccount.findUnique({ where: { id }, select: safeSelect });
  }
  create(dto: CreatePlatformAccountDto, user: AuthUser) {
    return this.prisma.platformAccount.create({
      data: {
        userId: user.id,
        platform: dto.platform,
        accountName: dto.accountName,
        externalAccountId: dto.externalAccountId,
        encryptedAccessToken: dto.accessToken ? this.encryption.encrypt(dto.accessToken) : null,
        encryptedRefreshToken: dto.refreshToken ? this.encryption.encrypt(dto.refreshToken) : null,
        connectionStatus: dto.accessToken ? 'CONNECTED' : 'DISCONNECTED',
      },
      select: safeSelect,
    });
  }
  async update(id: string, dto: UpdatePlatformAccountDto, user: AuthUser) {
    await this.assertOwned(id, user);
    return this.prisma.platformAccount.update({ where: { id }, data: dto, select: safeSelect });
  }
  async remove(id: string, user: AuthUser) {
    await this.assertOwned(id, user);
    await this.prisma.platformAccount.delete({ where: { id } });
    return { deleted: true };
  }
  async test(id: string, user: AuthUser) {
    const row = await this.assertOwned(id, user);
    return { connected: row.connectionStatus === 'CONNECTED', status: row.connectionStatus };
  }
  async session(id: string, user: AuthUser) {
    await this.assertOwned(id, user);
    return this.prisma.browserSession.findUnique({
      where: { platformAccountId: id },
      select: { sessionStatus: true, lastValidatedAt: true, expiresAt: true },
    });
  }
}
