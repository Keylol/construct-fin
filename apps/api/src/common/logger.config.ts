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

    // Никогда не писать секреты в лог: заголовок авторизации, куки (в них JWT),
    // а также исходящий set-cookie.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      remove: true,
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
