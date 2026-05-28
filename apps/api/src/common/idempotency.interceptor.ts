import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { of, type Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_HEADER = 'idempotency-key';

/**
 * Идемпотентность: клиент шлёт заголовок `Idempotency-Key: <uuid>` на
 * мутирующих эндпойнтах. Сервер сохраняет (ключ → ответ) на 24 часа.
 * При повторе тем же ключом и теми же телом+URL возвращается тот же ответ.
 *
 * Реализован как пассивный — без заголовка работает как обычно. Клиент
 * добавляет ключ только там, где действительно нужно (платёж, закупка,
 * finalize), чтобы избежать дублирования при retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const method = (req.method ?? '').toUpperCase();
    if (!MUTATING.has(method)) return next.handle();

    const headerValue = req.headers[KEY_HEADER];
    const key = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!key || key.length < 8 || key.length > 200) return next.handle();

    const requestHash = hashRequest(method, req.url ?? '', req.body);

    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency-Key уже использовался с другим запросом',
        );
      }
      return of(existing.responseBody);
    }

    return next.handle().pipe(
      tap({
        next: async (body) => {
          await this.storeResponse(key, requestHash, body);
        },
      }),
    );
  }

  private async storeResponse(
    key: string,
    requestHash: string,
    body: unknown,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    const json = (body ?? null) as Prisma.InputJsonValue;
    try {
      await this.prisma.idempotencyKey.upsert({
        where: { key },
        create: { key, requestHash, responseBody: json, expiresAt },
        update: { requestHash, responseBody: json, expiresAt },
      });
    } catch (err) {
      // Идемпотентный кэш — не критично, основной запрос уже успешен.
      console.error('[idempotency] failed to store response', err);
    }
  }
}

/** sha256(method + url + JSON.stringify(body)). */
function hashRequest(method: string, url: string, body: unknown): string {
  const payload = `${method}\n${url}\n${stableStringify(body)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/** Стабильная сериализация: ключи объектов сортируем, иначе хэш плавает. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// Экспорт чисто для тестов.
export const __testing__ = { hashRequest, stableStringify };
