import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface OdooSessionResult {
  uid?: number | false;
  name?: string;
  username?: string;
}

interface OdooSessionResponse {
  result?: OdooSessionResult;
  error?: {
    message?: string;
    data?: { message?: string };
  };
}

export interface OdooUser {
  id: number;
  name: string;
}

@Injectable()
export class OdooService {
  private readonly logger = new Logger(OdooService.name);

  constructor(private readonly config: ConfigService) {}

  async authenticate(email: string, password: string): Promise<OdooUser> {
    const baseUrl = this.config.getOrThrow<string>('ODOO_URL').replace(/\/+$/, '');
    const db = this.config.getOrThrow<string>('ODOO_DB');

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/web/session/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: { db, login: email.trim(), password },
          id: Date.now(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      this.logger.error(
        `Cannot reach Odoo at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Không thể kết nối tới máy chủ Odoo.');
    }

    if (!response.ok) {
      this.logger.error(`Odoo authentication returned HTTP ${response.status}`);
      throw new ServiceUnavailableException('Máy chủ Odoo đang tạm thời không khả dụng.');
    }

    let payload: OdooSessionResponse;
    try {
      payload = (await response.json()) as OdooSessionResponse;
    } catch {
      throw new ServiceUnavailableException('Phản hồi từ máy chủ Odoo không hợp lệ.');
    }

    const uid = payload.result?.uid;
    if (!uid) {
      if (payload.error) {
        this.logger.warn(
          `Odoo authentication error: ${payload.error.data?.message ?? payload.error.message ?? 'unknown'}`,
        );
      }
      throw new UnauthorizedException('Email hoặc mật khẩu Odoo không chính xác.');
    }

    return {
      id: uid,
      name: payload.result?.name?.trim() || payload.result?.username?.trim() || email.trim(),
    };
  }
}
