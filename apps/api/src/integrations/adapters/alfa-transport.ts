import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import type { ConfigSchema } from '../../config';
import type { BankHttp, BankHttpResponse } from './bank-http';

/**
 * Транспорт к Alfa API (Ф2). Отдельный класс, потому что у него две обязанности,
 * которые нельзя проверить юнит-тестом адаптера: mTLS-соединение (клиентский
 * сертификат + доверенная цепочка) и сеть. Адаптер зависит от интерфейса
 * `AlfaHttp`, поэтому в тестах подменяется одним объектом без сети.
 *
 * Почему `node:https`, а не глобальный fetch: клиентский сертификат задаётся
 * только через агент соединения, а fetch в Node принимает его лишь через
 * undici-dispatcher — это внешняя зависимость ради того, что `https.Agent`
 * умеет из коробки. Никаких новых пакетов в проект.
 *
 * Все вызовы Alfa API идут по mTLS (требование песочницы и прома). Сертификат
 * выдаёт банк, он общий для всех подключений пространства, поэтому живёт в env
 * сервера (пути к файлам), а не в БД: в БД — только API Key подключения.
 */

/** Контракт транспорта — общий для банковских адаптеров (см. bank-http.ts). */
export type AlfaHttpResponse = BankHttpResponse;
export type AlfaHttp = BankHttp;

/** DI-токен транспорта: тесты подставляют вместо него объект без сети. */
export const ALFA_HTTP = Symbol('ALFA_HTTP');

/** Потолок тела ответа: страница выписки — до 1000 операций, ~2-3 МБ с запасом. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class AlfaTransport implements AlfaHttp {
  private readonly logger = new Logger(AlfaTransport.name);
  private agent: Agent | null = null;

  constructor(private readonly config: ConfigService<ConfigSchema, true>) {}

  /**
   * Настроен ли mTLS. Без сертификата адаптер не регистрируется в реестре, и
   * подключение Альфы честно отвечает 503 вместо попытки уйти в сеть без ключа.
   */
  get configured(): boolean {
    return (
      !!this.config.get('ALFA_TLS_CERT_PATH', { infer: true }) &&
      !!this.config.get('ALFA_TLS_KEY_PATH', { infer: true })
    );
  }

  /**
   * Агент с клиентским сертификатом. Создаётся один раз и переиспользуется
   * (keep-alive): при цикле по дням это десятки запросов подряд, и новый
   * TLS-handshake на каждый день — лишние секунды и нагрузка на банк.
   */
  private getAgent(): Agent {
    if (this.agent) return this.agent;

    const certPath = this.config.get('ALFA_TLS_CERT_PATH', { infer: true });
    const keyPath = this.config.get('ALFA_TLS_KEY_PATH', { infer: true });
    if (!certPath || !keyPath) {
      throw new Error(
        'Alfa API не настроен: не заданы ALFA_TLS_CERT_PATH и ALFA_TLS_KEY_PATH',
      );
    }
    const caPath = this.config.get('ALFA_TLS_CA_PATH', { infer: true });
    const passphrase = this.config.get('ALFA_TLS_KEY_PASSPHRASE', { infer: true });

    // Ошибка чтения файла — с путём, но без содержимого: в лог не должен попасть
    // ни закрытый ключ, ни его парольная фраза.
    const read = (path: string, label: string): Buffer => {
      try {
        return readFileSync(path);
      } catch {
        throw new Error(`Alfa API: не удалось прочитать ${label} по пути ${path}`);
      }
    };

    this.agent = new Agent({
      cert: read(certPath, 'клиентский сертификат'),
      key: read(keyPath, 'закрытый ключ'),
      ...(caPath ? { ca: read(caPath, 'цепочку УЦ') } : {}),
      ...(passphrase ? { passphrase } : {}),
      keepAlive: true,
      maxSockets: 4,
    });
    return this.agent;
  }

  async getJson(url: string, headers: Record<string, string>): Promise<AlfaHttpResponse> {
    const agent = this.getAgent();
    return new Promise<AlfaHttpResponse>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method: 'GET', agent, headers, timeout: REQUEST_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              res.destroy();
              reject(new Error('Alfa API: ответ превысил допустимый размер'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`Alfa API: таймаут запроса (${REQUEST_TIMEOUT_MS} мс)`));
      });
      // Сообщения сетевых ошибок Node несут только хост/код (ECONNREFUSED и т.п.),
      // но URL с параметрами сюда не подставляем — в нём номер расчётного счёта.
      req.on('error', (e) => reject(e));
      req.end();
    });
  }

  /** Сбросить агент (после смены сертификата на диске — без рестарта контейнера). */
  resetAgent(): void {
    this.agent?.destroy();
    this.agent = null;
    this.logger.log('Alfa API: TLS-агент сброшен, сертификат будет перечитан');
  }
}
