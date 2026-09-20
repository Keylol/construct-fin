import { Injectable } from '@nestjs/common';

/**
 * Транспорт к amoCRM API v4. Клиент зависит от этого интерфейса, а не от
 * fetch: тесты подставляют объект без сети (как ALFA_HTTP/TBANK_HTTP у банков).
 *
 * Тело ответа отдаётся строкой: разбор — забота AmoClient, который знает
 * формат amo (в том числе 204 без тела на пустой выборке).
 */
export interface AmoHttpResponse {
  status: number;
  body: string;
}

export interface AmoHttp {
  getJson(url: string, headers: Record<string, string>): Promise<AmoHttpResponse>;
}

/** DI-токен транспорта: тесты подставляют объект без сети. */
export const AMO_HTTP = Symbol('AMO_HTTP');

/**
 * Таймаут одного запроса. amo обязуется отвечать быстро; 15 с — граница между
 * «сеть подвисла» и «сервер думает». Синк идёт страницами, поэтому один
 * зависший запрос не должен держать cron дольше необходимого.
 */
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class AmoTransport implements AmoHttp {
  async getJson(url: string, headers: Record<string, string>): Promise<AmoHttpResponse> {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
  }
}
