import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionalContext } from './transactional-context';

/**
 * Транзакционный клиент Prisma — то, что получают репозитории внутри UoW.
 * Совпадает с обычным PrismaClient по API, но scoped к одной транзакции.
 */
export type TxClient = Prisma.TransactionClient;

/**
 * Unit of Work — единая точка для атомарных мульти-табличных операций.
 *
 * Пластичность: доменные use-case'ы зависят от этого интерфейса, а не от
 * Prisma напрямую. Если ORM сменится — переписываем только реализацию
 * `run()`, сигнатура остаётся. Репозитории получают `TxClient` и не открывают
 * собственных транзакций.
 *
 * Пример:
 *   await uow.run(async (tx) => {
 *     await orderRepo.using(tx).updatePaid(orderId, newPaid);
 *     await txRepo.using(tx).create(payment);
 *   });
 */
@Injectable()
export class UnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txContext: TransactionalContext,
  ) {}

  run<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await fn(tx);
      // Внутритранзакционные финализаторы (напр. idempotency-маркер completedAt)
      // выполняются ВНУТРИ этой же транзакции перед коммитом — атомарно с
      // доменной работой. No-op вне request-контекста и без хуков, поэтому
      // на все существующие uow.run (cron, прямые вызовы, не-идемпотентные
      // запросы) поведение не меняется.
      await this.txContext.drainCommitHooks(tx);
      return result;
    });
  }
}
