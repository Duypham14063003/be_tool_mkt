import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

@Injectable()
export class EncryptionService {
  constructor(private readonly config: ConfigService) {}
  private key(): Buffer {
    const value = this.config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes in base64');
    return key;
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
  }
  decrypt(envelope: string): string {
    const [iv, tag, encrypted] = envelope.split('.').map((part) => Buffer.from(part, 'base64'));
    if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
