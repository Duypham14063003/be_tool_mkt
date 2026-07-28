import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LoginDto } from './dto';
import { OdooService } from './odoo.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private odoo: OdooService,
    private auditLogs: AuditLogsService,
  ) {}

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private refreshTtlMs(): number {
    const value = this.config.get('JWT_REFRESH_TTL', '7d');
    const match = /^(\d+)([smhd])$/.exec(value);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const unit =
      match[2] === 's'
        ? 1_000
        : match[2] === 'm'
          ? 60_000
          : match[2] === 'h'
            ? 3_600_000
            : 86_400_000;
    return Number(match[1]) * unit;
  }

  private async tokens(
    user: { id: string; email: string; role: string },
    device?: { id?: string; name?: string },
  ) {
    const secret = randomBytes(32).toString('base64url');
    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: this.digest(secret),
        deviceId: device?.id,
        deviceName: device?.name,
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });
    const payload = { sub: user.id, email: user.email, role: user.role, sid: session.id };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL', '15m'),
    });
    const refreshToken = `${session.id}.${secret}`;
    return { accessToken, refreshToken };
  }

  async login(dto: LoginDto, context?: { ipAddress?: string; userAgent?: string }) {
    const email = dto.email.trim().toLowerCase();

    // Bước 1: Xác thực với Odoo (throws nếu sai credentials hoặc Odoo offline)
    const odooUser = await this.odoo.authenticate(email, dto.password);

    // Bước 2: Tự động tạo hoặc cập nhật user trong DB local
    const [userByOdooUid, userByEmail] = await Promise.all([
      this.prisma.user.findUnique({ where: { odooUid: odooUser.uid } }),
      this.prisma.user.findUnique({ where: { email } }),
    ]);

    // Never silently merge two local identities. This can otherwise transfer the
    // role and data of one local user to a different Odoo account.
    if (userByOdooUid && userByEmail && userByOdooUid.id !== userByEmail.id) {
      throw new ConflictException(
        'Tài khoản Odoo xung đột với tài khoản hiện có. Vui lòng liên hệ quản trị viên.',
      );
    }

    if (userByEmail?.odooUid && userByEmail.odooUid !== odooUser.uid) {
      throw new ConflictException('Email này đã được liên kết với một tài khoản Odoo khác.');
    }

    const existing = userByOdooUid ?? userByEmail;
    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            odooUid: odooUser.uid,
            email,
            name: odooUser.name,
            role: existing.role === Role.VIEWER ? Role.MARKETING : existing.role,
            lastSeenAt: new Date(),
          },
        })
      : await this.prisma.user.create({
          data: {
            odooUid: odooUser.uid,
            email,
            name: odooUser.name,
            // Không lưu password hash — xác thực hoàn toàn qua Odoo
            passwordHash: null,
            role: Role.MARKETING,
            status: 'ACTIVE',
            lastSeenAt: new Date(),
          },
        });

    // Bước 3: Kiểm tra user không bị vô hiệu hóa thủ công trong DB local
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên để được hỗ trợ.',
      );
    }

    const tokenPair = await this.tokens(user, { id: dto.device_id, name: dto.device_name });
    await this.auditLogs.record({
      userId: user.id,
      action: 'LOGIN',
      entityType: 'UserSession',
      entityId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      newData: {
        provider: 'ODOO',
        odooUid: odooUser.uid,
        deviceId: dto.device_id ?? null,
        deviceName: dto.device_name ?? null,
      },
    });
    return {
      ...tokenPair,
      user: this.authUserResponse(user),
    };
  }

  async refresh(token: string) {
    try {
      const separator = token.indexOf('.');
      if (separator < 1) throw new Error();
      const sessionId = token.slice(0, separator);
      const secret = token.slice(separator + 1);
      const session = await this.prisma.userSession.findUnique({
        where: { id: sessionId },
        include: { user: true },
      });
      if (
        !session ||
        session.expiresAt <= new Date() ||
        session.refreshTokenHash !== this.digest(secret) ||
        session.user.status !== 'ACTIVE'
      )
        throw new Error();
      await this.prisma.userSession.delete({ where: { id: session.id } });
      return this.tokens(session.user, {
        id: session.deviceId ?? undefined,
        name: session.deviceName ?? undefined,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  logout(userId: string, sessionId: string) {
    return this.prisma.userSession.deleteMany({ where: { id: sessionId, userId } });
  }

  me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    });
  }

  private authUserResponse(user: { id: string; email: string; name: string; role: Role }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      department: null,
      job_title: null,
      phone_number: null,
      employment_status: null,
      avatar_url: null,
      roles: [user.role.toLowerCase()],
      jobTitle: null,
      phoneNumber: null,
      employmentStatus: null,
      avatarUrl: null,
    };
  }
}
