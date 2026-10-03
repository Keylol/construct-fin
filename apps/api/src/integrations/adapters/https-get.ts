import { request as httpsRequest, type Agent } from 'node:https';
import { rootCertificates } from 'node:tls';
import type { BankHttpResponse } from './bank-http';
import { RUSSIAN_TRUSTED_ROOT_CA } from './russian-trusted-root-ca';

/** Потолок тела ответа: страница выписки — до 1000 операций, ~2-3 МБ с запасом. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Доверенные корни для банков: системный набор Node плюс корень Минцифры.
 *
 * Корни ДОПОЛНЯЕМ, а не заменяем: `ca` в Node вытесняет системный набор
 * целиком, и соединение с любым обычным сервером (или с самим банком, если он
 * сменит УЦ) сломалось бы. Корень Минцифры нужен потому, что и баас Альфы, и
 * `business.tbank.ru` подписаны Russian Trusted Root CA, которого в
 * стандартном наборе Node нет.
 */
export const BANK_TRUSTED_CA: readonly string[] = [...rootCertificates, RUSSIAN_TRUSTED_ROOT_CA];

/**
 * GET к API банка через `node:https` с агентом конкретного банка.
 *
 * Почему не глобальный fetch: свои доверенные корни (и клиентский сертификат
 * Альфы) задаются только через агент соединения, а fetch в Node принимает их
 * лишь через undici-dispatcher — внешнюю зависимость ради того, что
 * `https.Agent` умеет из коробки.
 *
 * `label` — имя API в текстах ошибок («Alfa API», «T-Bank API»): они доезжают
 * до владельца в статусе подключения.
 */
export function httpsGetJson(
  url: string,
  headers: Record<string, string>,
  agent: Agent,
  label: string,
): Promise<BankHttpResponse> {
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
            reject(new Error(`${label}: ответ превысил допустимый размер`));
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
      req.destroy(new Error(`${label}: таймаут запроса (${REQUEST_TIMEOUT_MS} мс)`));
    });
    // Сообщения сетевых ошибок Node несут только хост/код (ECONNREFUSED и т.п.),
    // но URL с параметрами сюда не подставляем — в нём номер расчётного счёта.
    req.on('error', (e) => reject(e));
    req.end();
  });
}
