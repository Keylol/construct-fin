import { Injectable } from '@nestjs/common';
import { Agent } from 'node:https';
import type { BankHttp, BankHttpResponse } from './bank-http';
import { BANK_TRUSTED_CA, httpsGetJson } from './https-get';

/**
 * Транспорт к T-API Т-Бизнеса (Ф3). В отличие от Альфы, mTLS не требуется —
 * достаточно Bearer-токена из личного кабинета, клиентского сертификата нет.
 *
 * Свой агент всё же нужен: `business.tbank.ru` подписан Russian Trusted Root CA
 * (Минцифры), которого нет в наборе Node. С глобальным fetch каждый синк падал
 * безликим «fetch failed», и подключение стояло в «Ошибке» с 22.09.2026.
 * Агент доверяет системным корням плюс корню Минцифры — тот же набор, что у
 * Альфы (`BANK_TRUSTED_CA`).
 *
 * `configured` всегда true: адаптеру Т-Банка нечего настраивать на сервере,
 * весь секрет живёт в подключении (зашифрованный токен в БД).
 */

/** DI-токен транспорта: тесты подставляют объект без сети. */
export const TBANK_HTTP = Symbol('TBANK_HTTP');

@Injectable()
export class TbankTransport implements BankHttp {
  readonly configured = true;

  /** Один агент на все подключения: сертификата клиента нет, корни общие. */
  readonly agent = new Agent({ ca: [...BANK_TRUSTED_CA], keepAlive: true, maxSockets: 4 });

  async getJson(url: string, headers: Record<string, string>): Promise<BankHttpResponse> {
    return httpsGetJson(url, headers, this.agent, 'T-Bank API');
  }
}
