import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private odoo: OdooService,
    private auditLogs: AuditLogsService,
  ) { }

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
    const logContext = `email=${email}, deviceId=${dto.device_id ?? 'none'}, ip=${context?.ipAddress ?? 'unknown'}`;

    this.logger.log(`[login] START ${logContext}`);

    try {
      // Bước 1: Xác thực với Odoo (throws nếu sai credentials hoặc Odoo offline)
      this.logger.log(`[login] Step 1: authenticating with Odoo ${logContext}`);
      const odooUser = await this.odoo.authenticate(email, dto.password);
      this.logger.log(
        `[login] Step 1 OK: Odoo user authenticated email=${email}, odooUid=${odooUser?.id ?? 'none'}, name=${odooUser?.name ?? 'none'}`,
      );

      if (!odooUser) {
        this.logger.warn(`[login] Odoo returned empty user ${logContext}`);
        throw new UnauthorizedException('Sai email hoặc mật khẩu');
      }

      // Bước 2: Đồng bộ user với DB local
      this.logger.log(`[login] Step 2: finding local users email=${email}, odooUid=${odooUser.id}`);
      const [userByOdooUid, userByEmail] = await Promise.all([
        this.prisma.user.findUnique({ where: { odooUid: odooUser.id } }),
        this.prisma.user.findUnique({ where: { email } }),
      ]);
      this.logger.log(
        `[login] Step 2 OK: local lookup email=${email}, userByOdooUid=${userByOdooUid?.id ?? 'none'}, userByEmail=${userByEmail?.id ?? 'none'}, userByEmailOdooUid=${userByEmail?.odooUid ?? 'none'}`,
      );

      // Never silently merge two local identities. This can otherwise transfer the
      // role and data of one local user to a different Odoo account.
      if (userByOdooUid && userByEmail && userByOdooUid.id !== userByEmail.id) {
        this.logger.warn(
          `[login] Conflict: two local identities email=${email}, odooUid=${odooUser.id}, userByOdooUid=${userByOdooUid.id}, userByEmail=${userByEmail.id}`,
        );
        throw new ConflictException(
          'Tài khoản Odoo xung đột với tài khoản hiện có. Vui lòng liên hệ quản trị viên.',
        );
      }

      if (userByEmail?.odooUid && userByEmail.odooUid !== odooUser.id) {
        this.logger.warn(
          `[login] Conflict: email linked to different Odoo uid email=${email}, localOdooUid=${userByEmail.odooUid}, authenticatedOdooUid=${odooUser.id}`,
        );
        throw new ConflictException('Email này đã được liên kết với một tài khoản Odoo khác.');
      }

      const existing = userByOdooUid ?? userByEmail;
      this.logger.log(
        `[login] Step 3: ${existing ? 'updating' : 'creating'} local user email=${email}, existingUserId=${existing?.id ?? 'none'}, odooUid=${odooUser.id}`,
      );
      const user = existing
        ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            odooUid: odooUser.id,
            email,
            name: odooUser.name,
            role: existing.role === Role.VIEWER ? Role.MARKETING : existing.role,
            lastSeenAt: new Date(),
          },
        })
        : await this.prisma.user.create({
          data: {
            odooUid: odooUser.id,
            email,
            name: odooUser.name,
            // Không lưu password hash — xác thực hoàn toàn qua Odoo
            passwordHash: null,
            role: Role.MARKETING,
            status: 'ACTIVE',
            lastSeenAt: new Date(),
          },
        });
      this.logger.log(
        `[login] Step 3 OK: local user synced email=${email}, userId=${user.id}, role=${user.role}, status=${user.status}, odooUid=${user.odooUid ?? 'none'}`,
      );

      // Bước 3: Kiểm tra user không bị vô hiệu hóa thủ công trong DB local
      this.logger.log(`[login] Step 4: checking local user status email=${email}, userId=${user.id}`);
      if (user.status !== 'ACTIVE') {
        this.logger.warn(`[login] Step 4 blocked: inactive user email=${email}, userId=${user.id}`);
        throw new ForbiddenException(
          'Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên để được hỗ trợ.',
        );
      }

      this.logger.log(`[login] Step 5: creating tokens/session email=${email}, userId=${user.id}`);
      const tokenPair = await this.tokens(user, { id: dto.device_id, name: dto.device_name });
      this.logger.log(`[login] Step 5 OK: tokens/session created email=${email}, userId=${user.id}`);

      this.logger.log(`[login] Step 6: recording audit log email=${email}, userId=${user.id}`);
      await this.auditLogs.record({
        userId: user.id,
        action: 'LOGIN',
        entityType: 'UserSession',
        entityId: user.id,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        newData: {
          provider: 'ODOO',
          odooUid: odooUser.id,
          deviceId: dto.device_id ?? null,
          deviceName: dto.device_name ?? null,
        },
      });
      this.logger.log(`[login] Step 6 OK: audit log recorded email=${email}, userId=${user.id}`);

      this.logger.log(`[login] DONE email=${email}, userId=${user.id}`);
      return {
        ...tokenPair,
        user: this.authUserResponse(user),
      };
    } catch (error) {
      const errorDetails =
        error instanceof Error
          ? `name=${error.name}, message=${error.message}, stack=${error.stack}`
          : String(error);
      const prismaCode =
        error && typeof error === 'object' && 'code' in error
          ? `, code=${String((error as { code?: unknown }).code)}`
          : '';
      this.logger.error(`[login] FAILED ${logContext}${prismaCode}: ${errorDetails}`);
      throw error;
    }
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
