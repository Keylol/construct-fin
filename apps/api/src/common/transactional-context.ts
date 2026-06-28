import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TxClient } from './unit-of-work';

/**
 * Хук, выполняемый ВНУТРИ доменной транзакции непосредственно перед коммитом.
 * Получает тот же `tx`, что и доменная работа, — поэтому его запись атомарна
 * с денежным эффектом (коммитится/откатывается вместе с ним).
 */
export type CommitHook = (tx: TxClient) => Promise<void>;

interface TxStore {
  /** Idempotency-ключ текущего запроса (если есть). Для диагностики/инварианта. */
  idempotencyKey?: string;
  /** Финализаторы, которые UoW выполнит внутри транзакции перед коммитом. */
  commitHooks: CommitHook[];
}

/**
 * Request-scoped контекст поверх AsyncLocalStorage — НЕЙТРАЛЬНЫЙ механизм,
 * не знающий про идемпотентность. Позволяет HTTP-слою (интерцептору)
 * зарегистрировать «внутритранзакционный финализатор», который UnitOfWork
 * выполнит внутри доменной `$transaction` перед коммитом.
 *
 * Зачем: idempotency-маркер `completedAt` обязан фиксироваться АТОМАРНО с
 * денежной проводкой (иначе краш между коммитом домена и записью маркера
 * оставляет «деньги проведены, но ключ выглядит брошенным» → ретрай дублирует
 * платёж). Интерцептор работает снаружи доменной tx и не имеет к ней доступа;
 * ALS-контекст — стандартный для NestJS способ донести данные запроса до
 * глубоких слоёв без протаскивания через сигнатуры.
 *
 * UoW зависит ТОЛЬКО от этого обобщённого интерфейса (CommitHook), а не от
 * idempotency-слоя — связанность минимальна. Должен быть СИНГЛТОНОМ (один ALS
 * на процесс), поэтому провайдится в @Global PrismaModule.
 */
@Injectable()
export class TransactionalContext {
  private readonly als = new AsyncLocalStorage<TxStore>();

  /** Выполнить `cb` в новом контексте запроса. */
  run<T>(store: TxStore, cb: () => T): T {
    return this.als.run(store, cb);
  }

  /** Текущий store (undefined вне контекста — напр. cron/прямой вызов в тестах). */
  getStore(): TxStore | undefined {
    return this.als.getStore();
  }

  /**
   * Выполняет и ОЧИЩАЕТ накопленные commit-хуки внутри переданного `tx`.
   * Вызывается UoW изнутри `$transaction` после доменной работы, до коммита.
   * splice(0) — «runs-once»: хук срабатывает в первой же транзакции запроса
   * (для денежных хендлеров она единственная) и не повторяется во вложенных/
   * последующих `uow.run`. No-op вне контекста и без хуков.
   */
  async drainCommitHooks(tx: TxClient): Promise<void> {
    const store = this.als.getStore();
    if (!store || store.commitHooks.length === 0) return;
    const hooks = store.commitHooks.splice(0);
    for (const hook of hooks) await hook(tx);
  }
}
