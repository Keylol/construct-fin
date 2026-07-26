import { Injectable } from '@nestjs/common';
import type { BankHttp, BankHttpResponse } from './bank-http';

/**
 * Транспорт к T-API Т-Бизнеса (Ф3). В отличие от Альфы, mTLS не требуется —
 * достаточно Bearer-токена из личного кабинета, поэтому здесь хватает
 * глобального fetch, без агента и файлов на диске.
 *
 * `configured` всегда true: адаптеру Т-Банка нечего настраивать на сервере,
 * весь секрет живёт в подключении (зашифрованный токен в БД).
 */

/** DI-токен транспорта: тесты подставляют объект без сети. */
export const TBANK_HTTP = Symbol('TBANK_HTTP');

const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class TbankTransport implements BankHttp {
  readonly configured = true;

  async getJson(url: string, headers: Record<string, string>): Promise<BankHttpResponse> {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    };
  }
}
