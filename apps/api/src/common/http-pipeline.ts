import { HttpAdapterHost } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger as PinoAppLogger } from 'nestjs-pino';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { TelegramAlertService } from './telegram-alert.service';
import { normalizeRequestId } from './logger.config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyCookie = require('@fastify/cookie');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyMultipart = require('@fastify/multipart');

/**
 * Общий HTTP-пайплайн приложения: логгер, плагины Fastify, request-id, глобальные
 * интерсептор и фильтр. Вызывается ОДИНАКОВО из main.ts (прод) и из e2e-харнесса,
 * чтобы тесты гоняли ровно тот же пайплайн, что и прод (без дрейфа логов/поведения).
 *
 * Не входит: enableShutdownHooks/listen — это прод-специфика main.ts.
 */
export async function applyHttpPipeline(
  app: NestFastifyApplication,
  opts: { maxUploadMb: number },
): Promise<void> {
  // nestjs-pino как логгер приложения: Logger.* и внутренние логи Nest — тоже
  // структурный JSON (в тестах уровень silent, см. logger.config). Ставим первым,
  // чтобы логи фильтра/пайплайна ниже уже шли через pino — одинаково в prod и test.
  app.useLogger(app.get(PinoAppLogger));

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: opts.maxUploadMb * 1024 * 1024, files: 1 },
  });

  // L5 (наблюдаемость): request-id. Fastify управляет заголовками отдельно от
  // raw-response, поэтому ставим id Fastify-хуком onRequest (он срабатывает раньше
  // pino-http от nestjs-pino). Уважаем входящий x-request-id (nginx/клиент), иначе
  // генерируем UUID; тот же id кладём обратно в заголовок запроса — pino genReqId
  // переиспользует его, так request-лог, ответный заголовок и форензик-лог 5xx
  // (AllExceptionsFilter) несут ОДИН id.
  app.getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (req, reply, done) => {
      const id = normalizeRequestId(req.headers['x-request-id']);
      req.headers['x-request-id'] = id;
      reply.header('x-request-id', id);
      done();
    });

  app.useGlobalInterceptors(app.get(IdempotencyInterceptor));
  // Глобальный фильтр (Фаза 3 п.13 + L5): маппинг ошибок Prisma/Zod в 4xx,
  // сокрытие стектрейсов наружу, форензик-лог 5xx с request-id. HttpException
  // проходят без изменений — контракт ответов сохранён.
  app.useGlobalFilters(
    new AllExceptionsFilter(app.get(HttpAdapterHost), app.get(TelegramAlertService)),
  );
}
