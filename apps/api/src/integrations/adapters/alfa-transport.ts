import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import type { ConfigSchema } from '../../config';
import type { BankHttp, BankHttpResponse, TlsMaterial } from './bank-http';

/**
 * Транспорт к Alfa API (Ф2). Отдельный класс, потому что у него две обязанности,
 * которые нельзя проверить юнит-тестом адаптера: mTLS-соединение (клиентский
 * сертификат + доверенная цепочка) и сеть. Адаптер зависит от интерфейса
 * `BankHttp`, поэтому в тестах подменяется одним объектом без сети.
 *
 * Почему `node:https`, а не глобальный fetch: клиентский сертификат задаётся
 * только через агент соединения, а fetch в Node принимает его лишь через
 * undici-dispatcher — это внешняя зависимость ради того, что `https.Agent`
 * умеет из коробки. Никаких новых пакетов в проект.
 *
 * Сертификат приходит ОТ ПОДКЛЮЧЕНИЯ (банк выдаёт его на компанию по договору,
 * у разных ИП он разный). Сертификат из env остаётся запасным вариантом — для
 * подключений, заведённых до того, как загрузка появилась в интерфейсе.
 */

/** Потолок тела ответа: страница выписки — до 1000 операций, ~2-3 МБ с запасом. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Сколько разных сертификатов держим в кэше агентов (пространств — единицы). */
const MAX_AGENTS = 16;

@Injectable()
export class AlfaTransport implements BankHttp {
  private readonly logger = new Logger(AlfaTransport.name);
  /** Агент на сертификат: TLS-рукопожатие на каждый день выписки — дорого. */
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly config: ConfigService<ConfigSchema, true>) {}

  /**
   * Транспорт доступен всегда: сертификат теперь у подключения, и есть ли он —
   * выясняется в момент синка конкретного подключения, а не при старте
   * приложения.
   */
  readonly configured = true;

  /** Есть ли сертификат в env (запасной вариант для старых подключений). */
  get envConfigured(): boolean {
    return (
      !!this.config.get('ALFA_TLS_CERT_PATH', { infer: true }) &&
      !!this.config.get('ALFA_TLS_KEY_PATH', { infer: true })
    );
  }

  async getJson(
    url: string,
    headers: Record<string, string>,
    tls?: TlsMaterial,
  ): Promise<BankHttpResponse> {
    const agent = this.resolveAgent(tls);
    return new Promise<BankHttpResponse>((resolve, reject) => {
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

  /** Агент под сертификат подключения, иначе — под сертификат из env. */
  private resolveAgent(tls?: TlsMaterial): Agent {
    const material = tls ?? this.envMaterial();
    if (!material) {
      throw new Error(
        'Alfa API: у подключения нет клиентского сертификата. Загрузите сертификат и ключ в настройках интеграции',
      );
    }
    const cacheKey = agentCacheKey(material);
    const existing = this.agents.get(cacheKey);
    if (existing) return existing;

    const agent = new Agent({
      cert: material.cert,
      key: material.key,
      ...(material.ca ? { ca: material.ca } : {}),
      ...(material.passphrase ? { passphrase: material.passphrase } : {}),
      keepAlive: true,
      maxSockets: 4,
    });

    // Предохранитель памяти: карта не может расти бесконечно при ротациях.
    if (this.agents.size >= MAX_AGENTS) {
      for (const [key, old] of this.agents) {
        old.destroy();
        this.agents.delete(key);
        if (this.agents.size < MAX_AGENTS) break;
      }
    }
    this.agents.set(cacheKey, agent);
    return agent;
  }

  /** Сертификат из env: путь к файлам на сервере. Читается один раз на агент. */
  private envMaterial(): TlsMaterial | null {
    const certPath = this.config.get('ALFA_TLS_CERT_PATH', { infer: true });
    const keyPath = this.config.get('ALFA_TLS_KEY_PATH', { infer: true });
    if (!certPath || !keyPath) return null;

    const caPath = this.config.get('ALFA_TLS_CA_PATH', { infer: true });
    const passphrase = this.config.get('ALFA_TLS_KEY_PASSPHRASE', { infer: true });

    // Ошибка чтения файла — с путём, но без содержимого: в лог не должен попасть
    // ни закрытый ключ, ни его парольная фраза.
    const read = (path: string, label: string): string => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        throw new Error(`Alfa API: не удалось прочитать ${label} по пути ${path}`);
      }
    };

    return {
      cert: read(certPath, 'клиентский сертификат'),
      key: read(keyPath, 'закрытый ключ'),
      ...(caPath ? { ca: read(caPath, 'цепочку УЦ') } : {}),
      ...(passphrase ? { passphrase } : {}),
    };
  }

  /** Сбросить кэш агентов (после смены сертификата на диске). */
  resetAgents(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.logger.log('Alfa API: кэш TLS-агентов сброшен, сертификаты будут перечитаны');
  }
}

/**
 * Ключ кэша TLS-агентов — хеш пары cert+key, а не id подключения.
 *
 * Так у двух пространств с РАЗНЫМИ сертификатами гарантированно разные агенты
 * (иначе второй ИП пошёл бы в банк под чужим сертификатом), после ротации
 * сертификата старый агент не переиспользуется, а одинаковые пары делят
 * соединения. Вынесено отдельно, чтобы это свойство проверялось тестом.
 */
export function agentCacheKey(material: TlsMaterial): string {
  return createHash('sha256')
    .update(material.cert)
    .update(' ')
    .update(material.key)
    .update(' ')
    .update(material.passphrase ?? '')
    .digest('hex');
}

/** DI-токен транспорта: тесты подставляют вместо него объект без сети. */
export const ALFA_HTTP = Symbol('ALFA_HTTP');

/** Контракт транспорта — общий для банковских адаптеров (см. bank-http.ts). */
export type AlfaHttpResponse = BankHttpResponse;
export type AlfaHttp = BankHttp;
