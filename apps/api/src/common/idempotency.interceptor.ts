import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { of, from, throwError, type Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
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

    // Атомарно «застолбить» ключ ДО выполнения: кто успел вставить строку (PK
    // = key), тот владелец и выполняет запрос. Параллельный запрос с тем же
    // ключом упрётся в unique-конфликт и получит кэш/409 — без двойного эффекта.
    const reserved = await this.tryReserve(key, requestHash);
    if (!reserved.owns) {
      const ex = reserved.existing;
      if (ex.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency-Key уже использовался с другим запросом',
        );
      }
      if (ex.completedAt === null) {
        // Ключ застолблён, но ответ ещё не готов — запрос выполняется параллельно.
        throw new ConflictException('Запрос с этим Idempotency-Key ещё выполняется');
      }
      return of(ex.responseBody);
    }

    // Владеем ключом: выполняем хендлер. Ответ отдаём ТОЛЬКО после фиксации
    // кэша (mergeMap дожидается complete) — иначе мгновенный повтор увидел бы
    // ещё «висящий» ключ и получил ложный 409. На ошибку освобождаем резерв.
    return next.handle().pipe(
      mergeMap(async (body) => {
        await this.complete(key, body);
        return body;
      }),
      catchError((err) =>
        from(this.release(key)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  /**
   * Пытается атомарно занять ключ. Возвращает `{owns:true}` если строка
   * вставлена нами. При конфликте читает существующую: протухшую — удаляет и
   * пробует занять заново; живую — возвращает для отдачи кэша/409.
   */
  private async tryReserve(
    key: string,
    requestHash: string,
  ): Promise<{ owns: true } | { owns: false; existing: IdempotencyRow }> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    try {
      await this.prisma.idempotencyKey.create({
        data: { key, requestHash, responseBody: Prisma.JsonNull, completedAt: null, expiresAt },
      });
      return { owns: true };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') {
        throw e;
      }
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
      if (!existing) return this.tryReserve(key, requestHash); // исчез в гонке — повтор
      if (existing.expiresAt <= new Date()) {
        // Протух — освобождаем и пробуем занять заново.
        await this.prisma.idempotencyKey.deleteMany({
          where: { key, expiresAt: { lte: new Date() } },
        });
        return this.tryReserve(key, requestHash);
      }
      return { owns: false, existing };
    }
  }

  /** Зафиксировать успешный ответ под нашим ключом. */
  private async complete(key: string, body: unknown): Promise<void> {
    const json: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      body === null || body === undefined ? Prisma.JsonNull : (body as Prisma.InputJsonValue);
    try {
      await this.prisma.idempotencyKey.update({
        where: { key },
        data: { responseBody: json, completedAt: new Date() },
      });
    } catch (err) {
      // Кэш — не критично, основной запрос уже успешен.
      console.error('[idempotency] failed to store response', err);
    }
  }

  /** Освободить незавершённый резерв (хендлер упал) — чтобы клиент мог повторить. */
  private async release(key: string): Promise<void> {
    try {
      await this.prisma.idempotencyKey.deleteMany({ where: { key, completedAt: null } });
    } catch (err) {
      console.error('[idempotency] failed to release key', err);
    }
  }
}

interface IdempotencyRow {
  key: string;
  requestHash: string;
  responseBody: Prisma.JsonValue;
  completedAt: Date | null;
  expiresAt: Date;
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
