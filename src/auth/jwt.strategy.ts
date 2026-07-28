import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/auth.types';
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow('JWT_ACCESS_SECRET'),
    });
  }
  async validate(payload: { sub?: string; sid?: string }): Promise<AuthUser> {
    if (!payload.sub || !payload.sid) throw new UnauthorizedException();

    const session = await this.prisma.userSession.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          select: { id: true, email: true, role: true, status: true },
        },
      },
    });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE'
    ) {
      throw new UnauthorizedException();
    }

    return {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      sessionId: session.id,
    };
  }
}
