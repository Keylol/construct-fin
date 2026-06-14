/**
 * HTTP-харнесс для e2e-тестов: поднимает РЕАЛЬНОЕ Nest-приложение (AppModule)
 * на FastifyAdapter и гоняет запросы через Fastify `inject` (без открытия порта).
 *
 * В отличие от money-harness (сервис-уровень мимо гардов), здесь работает весь
 * пайплайн: ConfigModule (валидация env), JwtAuthGuard (Bearer/cookie),
 * WorkspaceGuard (проверка WorkspaceMember), интерсепторы и фильтры.
 *
 * ВАЖНО: env выставляется ДО импорта AppModule (ConfigModule валидирует env при
 * старте). Поэтому AppModule/JwtService импортируются динамически внутри функций.
 */
import { TEST_DATABASE_URL } from '../test/money-harness';

// ── env ДО импорта AppModule (ConfigModule.validate падает на невалидном env) ──
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

export interface InjectArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  token?: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

/** Ответ Fastify `inject` (light-my-request). statusCode/body/json() и т.д. */
export interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: <T = unknown>() => T;
}

export interface HttpApp {
  app: NestFastifyApplication;
  inject: (args: InjectArgs) => Promise<InjectResponse>;
  prisma: PrismaClient;
  jwtFor: (userId: string, telegramId: bigint | number | string) => Promise<string>;
}

/**
 * Поднимает приложение как в main.ts, но без listen — запросы идут через inject.
 * Регистрирует @fastify/cookie и @fastify/multipart, ставит глобальные
 * интерсептор/фильтр (чтобы поведение совпадало с прод-пайплайном).
 */
export async function buildHttpApp(): Promise<HttpApp> {
  // Динамический импорт ПОСЛЕ установки env (см. шапку файла).
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

  const { PrismaService } = await import('../prisma/prisma.service');
  const prisma = app.get(PrismaService) as unknown as PrismaClient;
  const jwt = app.get(JwtService);

  const fastify = app.getHttpAdapter().getInstance();

  const inject = async (args: InjectArgs): Promise<InjectResponse> => {
    const headers: Record<string, string> = { ...(args.headers ?? {}) };
    if (args.token) headers.authorization = `Bearer ${args.token}`;
    const res = await fastify.inject({
      method: args.method,
      url: args.url,
      headers,
      ...(args.payload !== undefined ? { payload: args.payload as object } : {}),
    });
    return res as unknown as InjectResponse;
  };

  const jwtFor = (userId: string, telegramId: bigint | number | string) =>
    jwt.signAsync({ sub: userId, tg: String(telegramId) });

  return { app, inject, prisma, jwtFor };
}
