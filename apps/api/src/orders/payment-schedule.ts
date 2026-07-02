import { Prisma } from '@prisma/client';
import { endOfDay } from '../reports/period';
import { D, money } from '../common/money';

/**
 * График платежей заказа (F2, #8a): план «суммы + даты» с контролем просрочки.
 *
 * План, не учёт: платежи к строкам НЕ привязываются (блиц 2026-07-02) —
 * покрытие выводится FIFO по (dueDate, seq) из общего Order.paidAmount.
 * Один источник истины (paidAmount) → рассинхрон невозможен по построению.
 *
 * Правила:
 *   • строка просрочена ПОСЛЕ конца дня dueDate в поясе бизнеса UTC+5
 *     (endOfDay из reports/period.ts, R5);
 *   • Σ строк может расходиться с totalAmount — мягкий флаг matchesTotal,
 *     не ошибка (график — план);
 *   • paidAmount < 0 (REFUNDED) покрытия не даёт (clamp в 0).
 *
 * Чистые функции — по образцу order-margin.ts.
 */

export type ScheduleEntryStatus = 'PAID' | 'PARTIAL' | 'PENDING' | 'OVERDUE';

/** Строка графика из БД (подмножество PaymentScheduleEntry). */
export interface ScheduleEntryRecord {
  id: string;
  seq: number;
  dueDate: Date;
  amount: Prisma.Decimal;
  note: string | null;
}

export interface ScheduleEntryView {
  id: string;
  seq: number;
  dueDate: string;
  amount: string;
  note: string | null;
  /** Покрыто платежами (FIFO): 0..amount. */
  covered: string;
  /** Остаток по строке: amount − covered. */
  remaining: string;
  status: ScheduleEntryStatus;
}

export interface ScheduleSummary {
  /** Σ строк графика. */
  planned: string;
  /** Σ строк == totalAmount заказа (false → UI предупреждает о расхождении). */
  matchesTotal: boolean;
  /** Σ остатков просроченных строк. */
  overdueAmount: string;
  /** Первая непогашенная строка (следующий платёж к оплате), null — всё погашено. */
  nextDueDate: string | null;
  nextDueAmount: string | null;
}

export interface ScheduleView {
  entries: ScheduleEntryView[];
  summary: ScheduleSummary;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Собрать представление графика: покрытие строк FIFO + статусы + сводка.
 * Возвращает null, если графика нет (заказ живёт как раньше).
 */
export function scheduleView(
  entries: ScheduleEntryRecord[],
  paidAmount: Prisma.Decimal | string,
  totalAmount: Prisma.Decimal | string,
  asOf: Date,
): ScheduleView | null {
  if (!entries.length) return null;

  const sorted = [...entries].sort(
    (a, b) =>
      a.dueDate.getTime() - b.dueDate.getTime() ||
      a.seq - b.seq ||
      a.id.localeCompare(b.id),
  );

  // Рефанды могут увести paidAmount в минус — покрытия это не даёт.
  let pool = Prisma.Decimal.max(D(paidAmount), ZERO);
  let planned = ZERO;
  let overdueAmount = ZERO;
  let nextDueDate: string | null = null;
  let nextDueAmount: string | null = null;

  const views: ScheduleEntryView[] = sorted.map((e) => {
    const amount = money(e.amount);
    planned = planned.plus(amount);

    const covered = Prisma.Decimal.min(pool, amount);
    pool = pool.minus(covered);
    const remaining = amount.minus(covered);

    const duePast = endOfDay(e.dueDate).getTime() < asOf.getTime();
    const status: ScheduleEntryStatus = remaining.isZero()
      ? 'PAID'
      : duePast
        ? 'OVERDUE'
        : covered.greaterThan(ZERO)
          ? 'PARTIAL'
          : 'PENDING';

    if (status === 'OVERDUE') overdueAmount = overdueAmount.plus(remaining);
    if (nextDueDate === null && remaining.greaterThan(ZERO)) {
      nextDueDate = e.dueDate.toISOString();
      nextDueAmount = remaining.toFixed(2);
    }

    return {
      id: e.id,
      seq: e.seq,
      dueDate: e.dueDate.toISOString(),
      amount: amount.toFixed(2),
      note: e.note,
      covered: covered.toFixed(2),
      remaining: remaining.toFixed(2),
      status,
    };
  });

  return {
    entries: views,
    summary: {
      planned: planned.toFixed(2),
      matchesTotal: planned.equals(D(totalAmount)),
      overdueAmount: overdueAmount.toFixed(2),
      nextDueDate,
      nextDueAmount,
    },
  };
}
