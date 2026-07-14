import type { AusnMark, IntegrationProvider, TxType } from '@prisma/client';

/**
 * Одна операция выписки в нормализованном виде (провайдер-агностично).
 * amount — модуль суммы Decimal-строкой (знак несёт direction), как в
 * Transaction.amount + Transaction.type.
 */
export interface RawBankLine {
  /** Идентификатор операции у провайдера — ключ идемпотентности синка. */
  externalId: string;
  date: Date;
  amount: string;
  direction: TxType; // INCOME | EXPENSE
  counterpartyName?: string | null;
  counterpartyInn?: string | null;
  description?: string | null;
  /** Маркировка АУСН из банка (для сверки Ф4), если провайдер её отдаёт. */
  ausnMark?: AusnMark | null;
  /** Сырой ответ провайдера — сохраняется в BankStatementLine.raw для форензики. */
  raw?: unknown;
}

export interface FetchStatementResult {
  lines: RawBankLine[];
  /** Курсор для следующего инкрементального синка (null — с начала). */
  nextCursor: string | null;
}

/**
 * Адаптер провайдера выписки. Реализации: FakeBankAdapter (Ф1, тесты/демо),
 * AlfaAdapter (Ф2), TbankAdapter (Ф3), WbPdfAdapter (Ф6). Чистый ввод-вывод:
 * получает токен + курсор, отдаёт нормализованные строки. Никакой записи в БД —
 * это делает SyncService.
 */
export interface BankProviderAdapter {
  readonly provider: IntegrationProvider | 'FAKE';
  fetchStatement(input: { token: string; cursor: string | null }): Promise<FetchStatementResult>;
}
