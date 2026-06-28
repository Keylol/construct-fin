/**
 * Нагрузочный харнесс: поднимает РЕАЛЬНОЕ Nest-приложение на FastifyAdapter и
 * слушает порт (в отличие от http-harness, который ходит через inject). Это даёт
 * честную конкуренцию: несколько сетевых клиентов одновременно бьют по API,
 * соревнуясь за строки БД через пул соединений Prisma под READ COMMITTED —
 * именно там проявляется недостаточность ручных SELECT ... FOR UPDATE.
 *
 * Цель — проверка инвариантов финансового учёта под многопользовательской
 * нагрузкой (имитация 3-5 пользователей и большого числа операций). Прод НЕ
 * затрагивается: используется только локальная тестовая БД construct_v6_test.
 *
 * ВАЖНО: env выставляется ДО импорта AppModule (ConfigModule валидирует env при
 * старте), поэтому AppModule/JwtService импортируются динамически внутри функции.
 */
import { TEST_DATABASE_URL } from '../test/money-harness';

// ── env ДО импорта AppModule ──
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-please-change-0123456789';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? 'test-bot-token';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? 'test_bot';
process.env.TELEGRAM_ALLOWED_IDS = '';
process.env.NODE_ENV = 'test';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyCookie = require('@fastify/cookie');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyMultipart = require('@fastify/multipart');

const PORT = Number(process.env.LOADTEST_PORT ?? 4100);
const HOST = '127.0.0.1';

export interface LoadApp {
  app: NestFastifyApplication;
  baseUrl: string;
  prisma: PrismaClient;
  jwtFor: (userId: string, telegramId: bigint | number | string) => Promise<string>;
  close: () => Promise<void>;
}

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

/**
 * Поднимает приложение как в main.ts и СЛУШАЕТ порт (реальный TCP).
 * Регистрирует @fastify/cookie + @fastify/multipart, глобальные интерсептор/фильтр.
 */
export async function buildLoadApp(): Promise<LoadApp> {
  const { AppModule } = await import('../app.module');
  const { IdempotencyInterceptor } = await import('../common/idempotency.interceptor');
  const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  app.useGlobalInterceptors(app.get(IdempotencyInterceptor));
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  await app.init();
  await app.listen(PORT, HOST);

  const { PrismaService } = await import('../prisma/prisma.service');
  const prisma = app.get(PrismaService) as unknown as PrismaClient;
  const jwt = app.get(JwtService);

  const baseUrl = `http://${HOST}:${PORT}`;
  const jwtFor = (userId: string, telegramId: bigint | number | string) =>
    jwt.signAsync({ sub: userId, tg: String(telegramId) });

  return {
    app,
    baseUrl,
    prisma,
    jwtFor,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Тонкий HTTP-клиент над global fetch. Не бросает на не-2xx — возвращает
 * { status, ok, body } (нагрузка должна продолжаться при ожидаемых 400/409).
 * Бросает только на сетевых сбоях.
 */
export async function call<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  // content-type ставим ТОЛЬКО при наличии тела — как продовый apps/web/src/lib/api.ts.
  // Иначе body-less POST (finalize) с json-типом и пустым телом ловит
  // FST_ERR_CTP_EMPTY_JSON_BODY (Fastify). Реальный клиент так не делает.
  const hasBody = opts.body !== undefined;
  const headers: Record<string, string> = hasBody ? { 'content-type': 'application/json' } : {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, ok: res.ok, body: body as T };
}
