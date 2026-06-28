/**
 * Интеграционные тесты идемпотентности против реальной БД (construct_v6_test).
 * Проверяют атомарный reserve (Фаза 4 п.19): параллельные запросы с одним
 * ключом не выполняют хендлер дважды.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Observable, lastValueFrom } from 'rxjs';
import {
  ConflictException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { TransactionalContext } from './transactional-context';
import { UnitOfWork, type TxClient } from './unit-of-work';
import { TEST_DATABASE_URL } from '../test/money-harness';

const prisma = new PrismaService({
  datasources: { db: { url: TEST_DATABASE_URL } },
}) as unknown as PrismaService;
const txContext = new TransactionalContext();
const interceptor = new IdempotencyInterceptor(prisma, txContext);
// Тот же txContext, что у интерцептора — иначе commit-hook не дошёл бы до UoW.
const uow = new UnitOfWork(prisma, txContext);

function ctx(method: string, url: string, body: unknown, key?: string): ExecutionContext {
  const req = { method, url, body, headers: key ? { 'idempotency-key': key } : {} };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** CallHandler, исполняющий fn() (опц. с задержкой) при подписке. */
function handler(fn: () => unknown, delayMs = 0): CallHandler {
  return {
    handle: () =>
      new Observable((sub) => {
        setTimeout(() => {
          try {
            sub.next(fn());
            sub.complete();
          } catch (e) {
            sub.error(e);
          }
        }, delayMs);
      }),
  };
}

async function run(c: ExecutionContext, h: CallHandler): Promise<unknown> {
  return lastValueFrom(await interceptor.intercept(c, h));
}

beforeAll(async () => {
  await (prisma as unknown as { $connect(): Promise<void> }).$connect();
});
afterAll(async () => {
  await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
});
beforeEach(async () => {
  await prisma.idempotencyKey.deleteMany({});
});

describe('IdempotencyInterceptor — атомарный reserve (п.19)', () => {
  it('повторный запрос тем же ключом отдаёт кэш, не выполняя хендлер второй раз', async () => {
    let calls = 0;
    const key = 'key-cache-1';
    const make = () => handler(() => ({ ok: true, n: ++calls }));

    const r1 = await run(ctx('POST', '/pay', { a: 1 }, key), make());
    expect(calls).toBe(1);
    expect(r1).toEqual({ ok: true, n: 1 });

    const r2 = await run(ctx('POST', '/pay', { a: 1 }, key), make());
    expect(calls).toBe(1); // хендлер НЕ выполнился повторно
    expect(r2).toEqual({ ok: true, n: 1 }); // отдан кэш
  });

  it('два параллельных запроса с одним ключом: хендлер выполняется один раз, второй получает 409', async () => {
    let calls = 0;
    const key = 'key-race-1';
    const slow = handler(() => ({ ok: true, n: ++calls }), 60);

    const results = await Promise.allSettled([
      run(ctx('POST', '/pay', { a: 1 }, key), slow),
      run(ctx('POST', '/pay', { a: 1 }, key), slow),
    ]);

    expect(calls).toBe(1);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it('B3: «зависший» in-flight резерв старше lease перезанимается ретраем', async () => {
    const key = 'key-stale-lease-1';
    // Симулируем краш: резерв застолблён 11 минут назад, ответ так и не зафиксирован
    // (completedAt=null), кэш ещё не протух (expiresAt в будущем). Без lease такой
    // ключ возвращал бы 409 «ещё выполняется» все 24ч.
    await prisma.idempotencyKey.create({
      data: {
        key,
        requestHash: 'stale-hash',
        responseBody: { Prisma: 'JsonNull' } as never,
        completedAt: null,
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    let calls = 0;
    const r = await run(
      ctx('POST', '/pay', { a: 1 }, key),
      handler(() => ({ ok: true, n: ++calls })),
    );
    expect(calls).toBe(1); // ретрай перезанял ключ и выполнил запрос
    expect(r).toEqual({ ok: true, n: 1 });
    // ключ теперь завершён (свежий резерв + completedAt проставлен)
    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(row.completedAt).not.toBeNull();
  });

  it('тот же ключ с другим телом → 409 (другой запрос)', async () => {
    const key = 'key-mismatch-1';
    await run(ctx('POST', '/pay', { a: 1 }, key), handler(() => ({ ok: 1 })));
    await expect(
      run(ctx('POST', '/pay', { a: 2 }, key), handler(() => ({ ok: 2 }))),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('при ошибке хендлера ключ освобождается — повтор выполняет запрос заново', async () => {
    let calls = 0;
    const key = 'key-release-1';
    await expect(
      run(
        ctx('POST', '/pay', { a: 1 }, key),
        handler(() => {
          calls++;
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);

    // release() — fire-and-forget; ждём, пока резерв исчезнет.
    for (let i = 0; i < 50; i++) {
      const row = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (!row) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await prisma.idempotencyKey.findUnique({ where: { key } })).toBeNull();

    const r = await run(
      ctx('POST', '/pay', { a: 1 }, key),
      handler(() => {
        calls++;
        return { ok: true };
      }),
    );
    expect(calls).toBe(2); // выполнился заново
    expect(r).toEqual({ ok: true });
  });
});

/**
 * Handler, исполняющий доменную работу через РЕАЛЬНЫЙ uow.run (как денежный
 * хендлер: addPayment/finalize/purchase). Это поднимает commit-hook
 * интерцептора внутри доменной транзакции через общий TransactionalContext.
 */
function uowHandler(
  domain: (tx: TxClient) => Promise<unknown>,
  opts: { crashAfterCommit?: boolean } = {},
): CallHandler {
  return {
    handle: () =>
      new Observable((sub) => {
        uow
          .run(async (tx) => domain(tx))
          .then((res) => {
            if (opts.crashAfterCommit) {
              // Имитация краха процесса ПОСЛЕ коммита домена, но ДО записи кэша
              // ответа (cacheResponse). Доменная tx уже закоммичена, completedAt
              // выставлен commit-hook'ом внутри неё.
              sub.error(new Error('crash после коммита, до cacheResponse'));
              return;
            }
            sub.next(res);
            sub.complete();
          })
          .catch((e) => sub.error(e));
      }),
  };
}

describe('IdempotencyInterceptor — атомарность completedAt с доменной tx (R6)', () => {
  it('completedAt фиксируется commit-hook ВНУТРИ доменной транзакции', async () => {
    const key = 'key-atomic-ok-1';
    let calls = 0;
    const r = await run(
      ctx('POST', '/pay', { a: 1 }, key),
      uowHandler(async () => {
        calls++;
        return { ok: true };
      }),
    );
    expect(calls).toBe(1);
    expect(r).toEqual({ ok: true });
    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(row.completedAt).not.toBeNull();
  });

  it('ALS-пропагация: idempotency-ключ виден из UnitOfWork внутри доменной tx', async () => {
    const key = 'key-atomic-als-1';
    let seenKey: string | undefined;
    await run(
      ctx('POST', '/pay', { a: 1 }, key),
      uowHandler(async () => {
        seenKey = txContext.getStore()?.idempotencyKey;
        return { ok: true };
      }),
    );
    expect(seenKey).toBe(key);
  });

  it('КРАШ после коммита домена (до записи кэша): маркер атомарен → ретрай НЕ дублирует [регресс R6]', async () => {
    const key = 'key-atomic-crash-1';
    let calls = 0;
    const make = (crash: boolean) =>
      uowHandler(
        async () => {
          calls++;
          return { ok: true, n: calls };
        },
        { crashAfterCommit: crash },
      );

    // 1-й запрос: домен коммитится (хук выставляет completedAt в той же tx),
    // затем «краш» до cacheResponse.
    await expect(run(ctx('POST', '/pay', { a: 1 }, key), make(true))).rejects.toThrow();
    expect(calls).toBe(1);

    // Несмотря на краш до записи кэша — completedAt ВЫСТАВЛЕН commit-hook'ом
    // внутри доменной tx. Это и есть доказательство атомарности.
    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(row.completedAt).not.toBeNull();

    // Состарим резерв старше lease и повторим тем же ключом.
    await prisma.idempotencyKey.update({
      where: { key },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    await run(ctx('POST', '/pay', { a: 1 }, key), make(false));

    // ДО фикса: completedAt писался только в cacheResponse (которого лишил краш)
    // → оставался null → lease перезанимал ключ → calls=2 (ДВОЙНОЙ платёж).
    // ПОСЛЕ фикса: completedAt!=null → отдан кэш, домен НЕ перевыполнен.
    expect(calls).toBe(1);
  });

  it('КРАШ до коммита (домен бросил внутри tx): хук не сработал → ключ освобождается, ретрай выполняет заново', async () => {
    const key = 'key-atomic-rollback-1';
    let calls = 0;
    await expect(
      run(
        ctx('POST', '/pay', { a: 1 }, key),
        uowHandler(async () => {
          calls++;
          throw new Error('boom внутри tx');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);

    // tx откатилась → commit-hook completedAt НЕ выставил → release удалил резерв.
    for (let i = 0; i < 50; i++) {
      if (!(await prisma.idempotencyKey.findUnique({ where: { key } }))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await prisma.idempotencyKey.findUnique({ where: { key } })).toBeNull();

    const r = await run(
      ctx('POST', '/pay', { a: 1 }, key),
      uowHandler(async () => {
        calls++;
        return { ok: true };
      }),
    );
    expect(calls).toBe(2); // выполнился заново (семантика B3 сохранена)
    expect(r).toEqual({ ok: true });
  });
});
