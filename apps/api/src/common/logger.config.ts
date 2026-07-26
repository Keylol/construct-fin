import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Нормализация request-id: входящий заголовок (строка или массив при дублях) →
 * одна строка; если пусто — новый UUID. Единый источник для Fastify-хука
 * (http-pipeline.ts, ставит id) и pino genReqId (читает тот же id) — чтобы не
 * разъехались.
 */
export function normalizeRequestId(incoming: string | string[] | undefined): string {
  return (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
}

/**
 * Разбор url для лога: путь отдельно, ИМЕНА query-параметров отдельно, значения
 * НЕ логируются вообще.
 *
 * Значения в query — это то, чего в логе быть не должно: OAuth-callback банка
 * несёт `?code=…`/`?access_token=…`, а поиск по операциям — назначения платежей
 * и имена контрагентов. Имён параметров хватает для отладки маршрутов.
 */
export function splitUrlForLog(rawUrl: string): { path: string; queryKeys: string[] } {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return { path: rawUrl, queryKeys: [] };
  return {
    path: rawUrl.slice(0, qIdx),
    queryKeys: [...new Set(new URLSearchParams(rawUrl.slice(qIdx + 1)).keys())],
  };
}

/**
 * Заголовки запроса/ответа в логе — по БЕЛОМУ списку.
 *
 * Раньше логировались все заголовки с вычеркиванием `authorization`/`cookie`
 * (чёрный список). Чёрный список не масштабируется: любой новый секретный
 * заголовок (`x-api-key` банка, `x-telegram-init-data`, `proxy-authorization`)
 * попадал бы в лог до того, как кто-то вспомнит дописать его в redact. Белый
 * список безопасен по умолчанию.
 */
const REQ_HEADER_ALLOWLIST = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'referer',
  'x-request-id',
] as const;

const RES_HEADER_ALLOWLIST = ['content-type', 'content-length', 'x-request-id'] as const;

function pickHeaders(
  headers: Record<string, unknown> | undefined,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!headers) return out;
  for (const key of allow) {
    const v = headers[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Конфиг структурного логирования (L5, наблюдаемость).
 *
 * Один JSON-поток на stdout для request-логов и логов Nest (Logger.*), с общим
 * request-id на запрос. Даёт форензику 5xx (см. AllExceptionsFilter) и позволяет
 * клиенту/поддержке ссылаться на конкретный запрос по заголовку x-request-id.
 */
export const loggerParams: Params = {
  pinoHttp: {
    // В тестах молчим (иначе pino-pretty плодит worker-потоки и шум в выводе).
    level: process.env.LOG_LEVEL ?? (isProd ? 'info' : isTest ? 'silent' : 'debug'),

    // Единый request-id. Заголовок x-request-id к этому моменту уже нормализован
    // Fastify-хуком onRequest (http-pipeline.ts) — переиспользуем его, чтобы
    // request-лог нёс тот же id, что вернётся клиенту в ответе.
    genReqId: (req: IncomingMessage): string => normalizeRequestId(req.headers['x-request-id']),

    // /health пингуется docker'ом каждые 20s + внешним аптайм-монитором. Не
    // зашумляем request-лог успешными health-пингами; ошибки/5xx логируются всегда.
    autoLogging: {
      ignore: (req: IncomingMessage): boolean => req.url === '/health',
    },

    // Сериализация запроса/ответа по БЕЛОМУ списку (заменила чёрный список
    // redact): в лог попадают только путь без query, имена query-параметров и
    // разрешённые заголовки. Значения query, тела, cookie, Authorization,
    // x-api-key, set-cookie в лог не попадают в принципе — не потому что
    // вычеркнуты, а потому что не собираются.
    serializers: {
      req: (req: {
        id?: unknown;
        method?: string;
        url?: string;
        headers?: Record<string, unknown>;
        remoteAddress?: string;
        socket?: { remoteAddress?: string };
      }) => {
        const { path, queryKeys } = splitUrlForLog(req.url ?? '');
        return {
          id: req.id,
          method: req.method,
          url: path,
          ...(queryKeys.length > 0 ? { queryKeys } : {}),
          remoteAddress: req.remoteAddress ?? req.socket?.remoteAddress,
          headers: pickHeaders(req.headers, REQ_HEADER_ALLOWLIST),
        };
      },
      res: (res: {
        statusCode?: number;
        headers?: Record<string, unknown>;
        getHeaders?: () => Record<string, unknown>;
      }) => ({
        // Fastify всегда проставляет statusCode; ?? 0 — чтобы поле не пропало
        // из JSON-записи лога, если сериализатор позовут на недооформленном res.
        statusCode: res.statusCode ?? 0,
        headers: pickHeaders(res.headers ?? res.getHeaders?.(), RES_HEADER_ALLOWLIST),
      }),
    },

    // В dev — человекочитаемый однострочный вывод; в проде/тестах — сырой JSON на
    // stdout (в проде его собирает docker json-file с ротацией, L4). pino-pretty
    // только в dev: в тестах worker-поток транспорта оставляет висящие хэндлы.
    transport:
      isProd || isTest
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
  },
};
