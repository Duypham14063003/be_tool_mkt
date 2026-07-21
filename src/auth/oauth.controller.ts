import { Controller, Get, Query, Redirect, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { OAuthService } from './oauth.service';
import { Response } from 'express';

@Controller('auth')
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}


  /**
   * GET /auth/facebook
   * Yêu cầu đăng nhập JWT trước.
   * Redirect user sang Facebook login page.
   */
  @Get('facebook')
  @UseGuards(AuthGuard('jwt'))
  @Redirect()
  facebookLogin(@CurrentUser() user: AuthUser) {
    const url = this.oauthService.getFacebookAuthUrl(this.oauthService.createOAuthState(user.id));
    return { url, statusCode: 302 };
  }

  @Get('facebook/url')
  @UseGuards(AuthGuard('jwt'))
  facebookUrl(@CurrentUser() user: AuthUser) {
    return { url: this.oauthService.getFacebookAuthUrl(this.oauthService.createOAuthState(user.id)) };
  }

  /**
   * GET /auth/facebook/callback?code=...&state=...
   * Facebook redirect về đây sau khi user đăng nhập.
   * Lưu page tokens vào DB rồi redirect về frontend.
   */
  @Get('facebook/callback')
  async facebookCallback(
    @Query('code') code: string,
    @Query('state') userId: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(`http://localhost:3001/accounts?error=${encodeURIComponent(error)}`);
    }

    try {
      const verifiedUserId = this.oauthService.verifyOAuthState(userId);
      const result = await this.oauthService.handleFacebookCallback(code, verifiedUserId);
      return res.redirect(
        `http://localhost:3001/accounts?success=facebook&saved=${result.saved}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.redirect(
        `http://localhost:3001/accounts?error=${encodeURIComponent(msg)}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════
  //  TIKTOK
  // ══════════════════════════════════════════════════════════

  /**
   * GET /auth/tiktok
   * Yêu cầu đăng nhập JWT trước.
   * Redirect user sang TikTok login page.
   */
  @Get('tiktok')
  @UseGuards(AuthGuard('jwt'))
  @Redirect()
  tiktokLogin(@CurrentUser() user: AuthUser) {
    const url = this.oauthService.getTiktokAuthUrl(this.oauthService.createOAuthState(user.id));
    return { url, statusCode: 302 };
  }

  @Get('tiktok/url')
  @UseGuards(AuthGuard('jwt'))
  tiktokUrl(@CurrentUser() user: AuthUser) {
    return { url: this.oauthService.getTiktokAuthUrl(this.oauthService.createOAuthState(user.id)) };
  }

  /**
   * GET /auth/tiktok/callback?code=...&state=...
   * TikTok redirect về đây sau khi user authorize.
   */
  @Get('tiktok/callback')
  async tiktokCallback(
    @Query('code') code: string,
    @Query('state') userId: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(`http://localhost:3001/accounts?error=${encodeURIComponent(error)}`);
    }

    try {
      const verifiedUserId = this.oauthService.verifyOAuthState(userId);
      const result = await this.oauthService.handleTiktokCallback(code, verifiedUserId);
      return res.redirect(
        `http://localhost:3001/accounts?success=tiktok&saved=${result.saved}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return res.redirect(
        `http://localhost:3001/accounts?error=${encodeURIComponent(msg)}`,
      );
    }
  }
}
