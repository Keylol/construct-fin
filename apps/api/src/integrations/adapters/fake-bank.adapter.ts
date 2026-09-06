import { Injectable } from '@nestjs/common';
import type {
  BankProviderAdapter,
  FetchBalanceInput,
  FetchBalanceResult,
  FetchStatementInput,
  FetchStatementResult,
  RawBankLine,
} from '../provider-adapter';

/**
 * Фейковый провайдер для тестов и локального демо (Ф1). Детерминированный:
 * без случайности и без обращения к сети. Первый синк (cursor=null) отдаёт
 * фиксированный набор строк, разнообразных по знаку/назначению — чтобы прогнать
 * полный цикл «строки → авто-проводки по правилам → разбор в Inbox». Повторный
 * синк (cursor="done") отдаёт пусто (нечего добирать) — так проверяется
 * идемпотентность и продвижение курсора.
 *
 * В прод-режиме не используется: AdapterRegistry подключает фейк только вне
 * production (NODE_ENV != production).
 */
@Injectable()
export class FakeBankAdapter implements BankProviderAdapter {
  readonly provider = 'FAKE' as const;

  static readonly LINES: RawBankLine[] = [
    {
      externalId: 'fake-1',
      date: new Date('2026-07-01T09:00:00.000Z'),
      amount: '15000.00',
      direction: 'INCOME',
      counterpartyName: 'ООО «Ромашка»',
      counterpartyInn: '7701234567',
      description: 'Оплата по договору №14',
      ausnMark: 'INCOME',
    },
    {
      externalId: 'fake-2',
      date: new Date('2026-07-01T10:30:00.000Z'),
      amount: '250.00',
      direction: 'EXPENSE',
      description: 'Комиссия банка за перевод',
      ausnMark: 'NOT_COUNTED',
    },
    {
      externalId: 'fake-3',
      date: new Date('2026-07-02T12:00:00.000Z'),
      amount: '8000.00',
      direction: 'EXPENSE',
      counterpartyName: 'ИП Арендодатель',
      description: 'Аренда офиса за июль',
      ausnMark: 'EXPENSE',
    },
    {
      externalId: 'fake-4',
      date: new Date('2026-07-03T14:15:00.000Z'),
      amount: '1200.50',
      direction: 'EXPENSE',
      counterpartyName: 'Канцелярия+',
      description: 'Канцтовары',
      ausnMark: 'EXPENSE',
    },
  ];

  /**
   * Остаток по банку — по умолчанию не отдаётся (null): десятки тестов
   * полного цикла считают балансы от seed-значений, и молчаливый якорь их бы
   * переписал. Тест, проверяющий якорь, задаёт `balance` явно.
   */
  balance: FetchBalanceResult | null = null;

  // accountNumber/connectedAt фейку не нужны — набор строк фиксирован.
  fetchStatement(input: FetchStatementInput): Promise<FetchStatementResult> {
    if (input.cursor) {
      return Promise.resolve({ lines: [], nextCursor: input.cursor });
    }
    return Promise.resolve({ lines: FakeBankAdapter.LINES, nextCursor: 'done' });
  }

  fetchBalance(_input: FetchBalanceInput): Promise<FetchBalanceResult> {
    return Promise.resolve(this.balance ?? { current: null, openingAt: null });
  }
}
