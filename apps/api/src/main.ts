import 'reflect-metadata';
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyCookie = require('@fastify/cookie');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fastifyMultipart = require('@fastify/multipart');
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  // Структурный лог (Фаза 1 п.7): в проде включаем встроенный pino Fastify —
  // JSON на stdout, zero-dependency (pino уже в составе Fastify). В dev держим
  // выключенным, чтобы не зашумлять локальный вывод. Логи самого Nest (Logger.*)
  // остаются на ConsoleLogger — для их структуризации нужен nestjs-pino
  // (отдельная зависимость, вне зоны конфиг-фазы).
  const fastifyLogger = process.env.NODE_ENV === 'production' ? { level: process.env.LOG_LEVEL ?? 'info' } : false;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy (Фаза 2 п.12): api слушает 127.0.0.1 за nginx, поэтому без этого
    // req.ip = loopback и ThrottlerGuard на /auth/* лимитирует ГЛОБАЛЬНО, а не по IP.
    // D2: trustProxy=1 (а НЕ true) — доверяем ровно ОДНОМУ хопу (nginx). Fastify
    // берёт правое значение X-Forwarded-For, которое nginx добавляет сам
    // ($proxy_add_x_forwarded_for → ..., $remote_addr). При trustProxy=true клиент
    // мог подделать XFF и ротировать бакет троттлинга /auth/login (обход лимита →
    // брутфорс пароля); с =1 подделанные левые значения игнорируются.
    new FastifyAdapter({ logger: fastifyLogger, trustProxy: 1 }),
    { bufferLogs: true },
  );

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_SIZE_MB ?? 10) * 1024 * 1024,
      files: 1,
    },
  });

  app.useGlobalInterceptors(app.get(IdempotencyInterceptor));
  // Глобальный фильтр (Фаза 3 п.13): маппинг ошибок Prisma/Zod в 4xx и сокрытие
  // стектрейсов. HttpException проходят без изменений — контракт ответов сохранён.
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? '0.0.0.0';

  await app.listen(port, host);
  Logger.log(`API ready at http://${host}:${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
