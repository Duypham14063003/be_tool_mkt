import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { EncryptionService } from '../common/encryption.service';
import { PrismaService } from '../database/prisma.service';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  createOAuthState(userId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ userId, exp: Date.now() + 10 * 60 * 1000, nonce: randomBytes(16).toString('hex') }),
    ).toString('base64url');
    const signature = createHmac('sha256', this.config.getOrThrow('JWT_ACCESS_SECRET'))
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyOAuthState(state: string): string {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) throw new UnauthorizedException('Invalid OAuth state');
    const expected = createHmac('sha256', this.config.getOrThrow('JWT_ACCESS_SECRET'))
      .update(payload)
      .digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid OAuth state');
    }
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      userId?: string;
      exp?: number;
    };
    if (!data.userId || !data.exp || data.exp < Date.now()) {
      throw new UnauthorizedException('OAuth state expired');
    }
    return data.userId;
  }

  /** Trả về URL để redirect user sang Facebook login */
  getFacebookAuthUrl(state: string): string {
    const appId = this.config.getOrThrow('FACEBOOK_APP_ID');
    const redirectUri = this.config.getOrThrow('FACEBOOK_REDIRECT_URI');
    const scopes = [
      'pages_read_engagement',
      'pages_show_list',
      'read_insights',
      'pages_read_user_content',
    ].join(',');

    const url = new URL('https://www.facebook.com/v20.0/dialog/oauth');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    return url.toString();
  }

  /** Nhận code từ callback → đổi lấy long-lived token → lưu pages vào DB */
  async handleFacebookCallback(code: string, userId: string): Promise<{ saved: number }> {
    const appId = this.config.getOrThrow('FACEBOOK_APP_ID');
    const appSecret = this.config.getOrThrow('FACEBOOK_APP_SECRET');
    const redirectUri = this.config.getOrThrow('FACEBOOK_REDIRECT_URI');

    // Bước 1: đổi code → short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
        `client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&client_secret=${appSecret}&code=${code}`,
    );
    const tokenData = await tokenRes.json() as { access_token?: string; error?: { message: string } };
    if (!tokenData.access_token) {
      throw new UnauthorizedException(`Facebook token exchange failed: ${tokenData.error?.message}`);
    }

    // Bước 2: đổi short-lived → long-lived token (60 ngày)
    const llRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
        `grant_type=fb_exchange_token&client_id=${appId}` +
        `&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`,
    );
    const llData = await llRes.json() as { access_token?: string; expires_in?: number };
    const userLongToken = llData.access_token ?? tokenData.access_token;

    // Bước 3: lấy danh sách Pages mà user quản lý
    const pagesRes = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=${userLongToken}`,
    );
    const pagesData = await pagesRes.json() as {
      data?: Array<{ id: string; name: string; access_token: string }>;
    };
    const pages = pagesData.data ?? [];

    if (pages.length === 0) {
      this.logger.warn(`Facebook user has no pages. Saving user token as fallback.`);
      // Lưu user token nếu không có page
      const meRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${userLongToken}`);
      const me = await meRes.json() as { id: string; name: string };
      await this.upsertPlatformAccount({
        userId,
        platform: Platform.FACEBOOK,
        accountName: me.name ?? 'Facebook User',
        externalAccountId: me.id,
        accessToken: userLongToken,
        expiresAt: llData.expires_in ? new Date(Date.now() + llData.expires_in * 1000) : null,
      });
      return { saved: 1 };
    }

    // Bước 4: lưu từng Page vào DB
    let saved = 0;
    for (const page of pages) {
      await this.upsertPlatformAccount({
        userId,
        platform: Platform.FACEBOOK,
        accountName: page.name,
        externalAccountId: page.id,
        accessToken: page.access_token, // Page token không hết hạn
        expiresAt: null,
      });
      saved++;
      this.logger.log(`Saved Facebook page: ${page.name} (${page.id})`);
    }

    return { saved };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TIKTOK
  // ══════════════════════════════════════════════════════════════════════════

  /** Trả về URL để redirect user sang TikTok login */
  getTiktokAuthUrl(state: string): string {
    const clientKey = this.config.getOrThrow('TIKTOK_CLIENT_KEY');
    const redirectUri = this.config.getOrThrow('TIKTOK_REDIRECT_URI');
    const scopes = ['user.info.basic', 'video.list'].join(',');

    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', clientKey);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    return url.toString();
  }

  /** Nhận code từ callback → đổi lấy access token → lưu vào DB */
  async handleTiktokCallback(code: string, userId: string): Promise<{ saved: number }> {
    const clientKey = this.config.getOrThrow('TIKTOK_CLIENT_KEY');
    const clientSecret = this.config.getOrThrow('TIKTOK_CLIENT_SECRET');
    const redirectUri = this.config.getOrThrow('TIKTOK_REDIRECT_URI');

    // Bước 1: đổi code → access token
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      refresh_token?: string;
      open_id?: string;
      expires_in?: number;
      refresh_expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      throw new UnauthorizedException(`TikTok token exchange failed: ${tokenData.error_description ?? tokenData.error}`);
    }

    // Bước 2: lấy thông tin user (tên hiển thị)
    const userRes = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    const userData = await userRes.json() as {
      data?: { user?: { open_id?: string; display_name?: string } };
    };
    const displayName = userData.data?.user?.display_name ?? 'TikTok Account';
    const openId = tokenData.open_id ?? userData.data?.user?.open_id ?? 'unknown';

    // Bước 3: lưu vào DB
    await this.upsertPlatformAccount({
      userId,
      platform: Platform.TIKTOK,
      accountName: displayName,
      externalAccountId: openId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    });

    this.logger.log(`Saved TikTok account: ${displayName} (${openId})`);
    return { saved: 1 };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Helper
  // ══════════════════════════════════════════════════════════════════════════

  private async upsertPlatformAccount(data: {
    userId: string;
    platform: Platform;
    accountName: string;
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date | null;
  }) {
    return this.prisma.platformAccount.upsert({
      where: {
        platform_externalAccountId_userId: {
          platform: data.platform,
          externalAccountId: data.externalAccountId,
          userId: data.userId,
        },
      },
      create: {
        userId: data.userId,
        platform: data.platform,
        accountName: data.accountName,
        externalAccountId: data.externalAccountId,
        encryptedAccessToken: this.encryption.encrypt(data.accessToken),
        encryptedRefreshToken: data.refreshToken ? this.encryption.encrypt(data.refreshToken) : null,
        tokenExpiresAt: data.expiresAt,
        connectionStatus: 'CONNECTED',
      },
      update: {
        accountName: data.accountName,
        encryptedAccessToken: this.encryption.encrypt(data.accessToken),
        encryptedRefreshToken: data.refreshToken ? this.encryption.encrypt(data.refreshToken) : null,
        tokenExpiresAt: data.expiresAt,
        connectionStatus: 'CONNECTED',
      },
    });
  }
}
