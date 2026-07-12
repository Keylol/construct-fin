import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { applyHttpPipeline } from './common/http-pipeline';

async function bootstrap() {
  // L5 (наблюдаемость): единый структурный лог через nestjs-pino. Request-логи
  // Fastify И логи самого Nest (Logger.*) идут одним JSON-потоком на stdout с
  // общим request-id (см. LoggerModule в app.module.ts). Прод-читаемость и
  // форензику даёт этот поток; Fastify-встроенный логгер отключаем (logger: false),
  // чтобы не дублировать pino-http от nestjs-pino.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy (Фаза 2 п.12): api слушает 127.0.0.1 за nginx, поэтому без этого
    // req.ip = loopback и ThrottlerGuard на /auth/* лимитирует ГЛОБАЛЬНО, а не по IP.
    // D2: trustProxy=1 (а НЕ true) — доверяем ровно ОДНОМУ хопу (nginx). Fastify
    // берёт правое значение X-Forwarded-For, которое nginx добавляет сам
    // ($proxy_add_x_forwarded_for → ..., $remote_addr). При trustProxy=true клиент
    // мог подделать XFF и ротировать бакет троттлинга /auth/login (обход лимита →
    // брутфорс пароля); с =1 подделанные левые значения игнорируются.
    new FastifyAdapter({ logger: false, trustProxy: 1 }),
    { bufferLogs: true },
  );

  // Общий HTTP-пайплайн (логгер nestjs-pino, плагины Fastify, request-id,
  // интерсептор, фильтр) — тот же код, что и в e2e-харнессе, чтобы прод и тесты
  // не расходились. bufferLogs выше держит ранние логи до подмены логгера внутри.
  await applyHttpPipeline(app, { maxUploadMb: Number(process.env.MAX_UPLOAD_SIZE_MB ?? 10) });

  // L7 (наблюдаемость): graceful shutdown. Nest ловит SIGTERM/SIGINT (docker stop
  // при каждом релизе), закрывает Fastify-сервер (перестаёт принимать, дожидается
  // in-flight запросов) и вызывает OnModuleDestroy-хуки (PrismaService.$disconnect).
  // Без этого рестарт рвёт активные запросы и оставляет висящие коннекты к БД.
  app.enableShutdownHooks();

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
