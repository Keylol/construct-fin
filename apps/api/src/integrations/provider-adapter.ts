import type { AusnMark, IntegrationProvider, TxType } from '@prisma/client';
import type { TlsMaterial } from './adapters/bank-http';

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

export interface FetchStatementInput {
  /** Секрет подключения: API Key (Альфа) или токен провайдера. */
  token: string;
  /** Курсор прошлого синка; null — первый проход. */
  cursor: string | null;
  /**
   * Внешний идентификатор счёта у провайдера (у Альфы — номер расчётного счёта).
   * null для провайдеров, которым он не нужен (FakeBank).
   */
  accountNumber?: string | null;
  /**
   * Когда подключение создано. Первый синк начинается с этого дня: история до
   * подключения уже занесена руками (решение №15 генплана «Полный автомат»).
   */
  connectedAt: Date;
  /**
   * Явная дата начала выгрузки, если пользователь просит историю глубже даты
   * подключения (перезалив). Перекрывает connectedAt; банк всё равно ограничит
   * своей глубиной хранения. Null — прежнее поведение.
   */
  backfillFrom?: Date | null;
  /**
   * Клиентский сертификат mTLS этого подключения (Альфа). null — сертификат не
   * загружен, транспорт возьмёт запасной из env. Т-Банку не нужен вовсе.
   */
  tls?: TlsMaterial | null;
}

/** Остаток счёта по данным банка на момент `at` (Decimal-строка со знаком). */
export interface BankBalanceSnapshot {
  amount: string;
  at: Date;
}

export interface FetchBalanceInput {
  token: string;
  accountNumber?: string | null;
  tls?: TlsMaterial | null;
  /**
   * С какой даты у нас есть строки выписки (backfillFrom либо дата подключения).
   * Провайдер, умеющий отдать остаток НА НАЧАЛО этого дня, отдаёт его в
   * `openingAt` — это точный начальный остаток счёта без вывода по формуле.
   */
  startFrom: Date;
}

export interface FetchBalanceResult {
  /** Текущий остаток по банку (null — провайдер не отдал). */
  current: BankBalanceSnapshot | null;
  /**
   * Остаток на начало `startFrom` (входящее сальдо выписки), если банк его
   * отдаёт. Точнее вывода «текущий − Σ строк»: не зависит от операций в пути.
   */
  openingAt: { amount: string; date: Date } | null;
}

/**
 * Адаптер провайдера выписки. Реализации: FakeBankAdapter (Ф1, тесты/демо),
 * AlfaAdapter (Ф2), TbankAdapter (Ф3), WbPdfAdapter (Ф6). Чистый ввод-вывод:
 * получает токен + курсор, отдаёт нормализованные строки. Никакой записи в БД —
 * это делает SyncService.
 *
 * `fetchBalance` необязателен: остаток нужен для «по банку» и якоря начального
 * остатка, но его отсутствие (провайдер не умеет, ключ без прав) не должно
 * останавливать синк выписки — SyncService переживёт и null, и исключение.
 */
export interface BankProviderAdapter {
  readonly provider: IntegrationProvider | 'FAKE';
  fetchStatement(input: FetchStatementInput): Promise<FetchStatementResult>;
  fetchBalance?(input: FetchBalanceInput): Promise<FetchBalanceResult>;
}
