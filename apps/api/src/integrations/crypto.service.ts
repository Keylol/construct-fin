import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ConfigSchema } from '../config';

/**
 * Шифрование секретов интеграций (токены банков/WB) — Ф1 «Полный автомат».
 *
 * AES-256-GCM: аутентифицированное шифрование, tag ловит подделку/битый ключ.
 * Мастер-ключ — из env `INTEGRATION_MASTER_KEY` (base64 от 32 байт). Не задан →
 * модуль интеграций выключен: encrypt/decrypt бросают 503 (как Telegram-алертинг
 * без chat_id). Формат хранения: `v1.<nonce_b64>.<tag_b64>.<ciphertext_b64>` —
 * версия впереди для будущей ротации схемы/ключа без гадания о формате.
 */
const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12; // рекомендованный размер IV для GCM

@Injectable()
export class CryptoService {
  private readonly key: Buffer | null;

  constructor(config: ConfigService<ConfigSchema, true>) {
    const raw = config.get('INTEGRATION_MASTER_KEY', { infer: true });
    // Длина уже провалидирована zod-refine в config.ts (32 байта); здесь только
    // декодируем. null → фича выключена.
    this.key = raw ? Buffer.from(raw, 'base64') : null;
  }

  /** Настроен ли мастер-ключ. UI/сервисы гейтят фичу по этому флагу. */
  get configured(): boolean {
    return this.key !== null;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'Интеграции недоступны: на сервере не задан INTEGRATION_MASTER_KEY',
      );
    }
    return this.key;
  }

  /** Шифрует секрет → строка `v1.<nonce>.<tag>.<ct>` (base64-сегменты). */
  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      nonce.toString('base64'),
      tag.toString('base64'),
      ct.toString('base64'),
    ].join('.');
  }

  /** Расшифровывает строку из encrypt(). Бросает при подделке/битом ключе (GCM). */
  decrypt(enc: string): string {
    const key = this.requireKey();
    const parts = enc.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Некорректный формат зашифрованного секрета');
    }
    // length===4 гарантирован проверкой выше — индексы не undefined.
    const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[1]!, 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Маска для UI: последние 4 символа секрета (сам секрет наружу не отдаётся). */
  static mask(secret: string): string {
    return secret.length <= 4 ? '****' : secret.slice(-4);
  }
}
