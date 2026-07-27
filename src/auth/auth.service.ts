import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { LoginDto } from './dto';
import { OdooService } from './odoo.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private odoo: OdooService,
  ) {}

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async tokens(user: { id: string; email: string; role: string }) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL', '15m'),
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_TTL', '7d'),
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: this.digest(refreshToken) },
    });
    return { accessToken, refreshToken };
  }

  async login(dto: LoginDto) {
    // Bước 1: Xác thực với Odoo (throws nếu sai credentials hoặc Odoo offline)
    const odooUser = await this.odoo.authenticate(dto.email, dto.password);

    // Bước 2: Tự động tạo hoặc cập nhật user trong DB local
    const user = await this.prisma.user.upsert({
      where: { email: dto.email.toLowerCase() },
      create: {
        email: dto.email.toLowerCase(),
        name: odooUser.name,
        // Không lưu password hash — xác thực hoàn toàn qua Odoo
        passwordHash: null,
        role: Role.VIEWER, // Role mặc định khi tạo mới; admin có thể đổi sau
        status: 'ACTIVE',
      },
      update: {
        // Cập nhật tên theo Odoo mỗi lần login
        name: odooUser.name,
      },
    });

    // Bước 3: Kiểm tra user không bị vô hiệu hóa thủ công trong DB local
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên để được hỗ trợ.');
    }

    // Bước 4: Cấp JWT
    return this.tokens(user);
  }

  async refresh(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user?.refreshTokenHash || user.refreshTokenHash !== this.digest(token))
        throw new Error();
      return this.tokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  logout(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
      select: { id: true },
    });
  }

  me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    });
  }
}
