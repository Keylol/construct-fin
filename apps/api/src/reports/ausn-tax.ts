import {
  Prisma,
  type AccountType,
  type AusnMark,
  type CategoryBucket,
  type TransactionKind,
  type TxType,
} from '@prisma/client';
import { add, sub, mul, money, D } from '../common/money';
import { classifyAusn, AUSN_RATE, AUSN_MIN_RATE, type AusnClass } from './ausn-classify';
import { businessDayParts, businessMonthLabel } from './period';

/**
 * Налог АУСН «Доходы − Расходы» по месяцам — единая формула для раздела «Налог»
 * (начисление и уплата по месяцам) и для ОПиУ, где с 27.09.2026 налог стоит
 * по начислению: в августе — налог за август, а не ЕНП за июль, уплаченный
 * 25 августа (решение владельца на аудите августа).
 */

export interface AusnTx {
  type: TxType;
  kind: TransactionKind;
  ausnMark: AusnMark | null;
  amount: Prisma.Decimal;
  date: Date;
  /** Группа статьи операции, если статья есть. */
  categoryBucket?: CategoryBucket | null;
  /** Тип счёта операции: наличные в базу АУСН не входят. */
  accountType?: AccountType | null;
}

export interface AusnMonthSums {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
  incomeCount: number;
  expenseCount: number;
}

export interface AusnMonthTax {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
  base: Prisma.Decimal;
  taxCalc: Prisma.Decimal;
  taxMin: Prisma.Decimal;
  taxDue: Prisma.Decimal;
}

/**
 * Класс операции для базы АУСН с учётом группы статьи.
 *
 * Наличные (счёт типа CASH) в базу не входят никогда. Дальше маркировка банка
 * (ausnMark) главнее всего. Без неё операции,
 * заведённые формой, «Входящими» или правилом, имеют kind=OTHER, и
 * classifyAusn видит только знак. Группа статьи уточняет то, что знак не видит:
 *  • «Налоги» — сам налог (ЕНП из выписки) в базу не входит;
 *  • «Вложения и изъятия» — деньги собственника в базу не входят;
 *  • «Закупки» у дохода — возврат от поставщика уменьшает расход, а не
 *    увеличивает доход.
 */
export function classifyAusnWithBucket(tx: AusnTx): AusnClass {
  // АУСН считает налоговая по данным банка: наличные в базу не попадают ни
  // доходом, ни расходом (владелец, 27.09.2026). Раньше наличная оплата заказа
  // поднимала минимальный налог, а наличная зарплата уменьшала базу.
  if (tx.accountType === 'CASH') return 'NOT_COUNTED';
  if (!tx.ausnMark && (tx.kind === 'OTHER' || tx.kind === 'NON_OP')) {
    if (tx.categoryBucket === 'TAX' || tx.categoryBucket === 'CAPITAL') return 'NOT_COUNTED';
    if (tx.categoryBucket === 'PURCHASES' && tx.type === 'INCOME') return 'EXPENSE_MINUS';
  }
  return classifyAusn(tx);
}

/** Доходы и расходы базы АУСН по месяцам бизнеса (UTC+5), метка «YYYY-MM». */
export function ausnSumsByMonth(txs: AusnTx[]): Map<string, AusnMonthSums> {
  const byMonth = new Map<string, AusnMonthSums>();
  for (const tx of txs) {
    const cls = classifyAusnWithBucket(tx);
    if (cls === 'NOT_COUNTED') continue;
    const label = businessMonthLabel(tx.date);
    const s = byMonth.get(label) ?? { income: D(0), expense: D(0), incomeCount: 0, expenseCount: 0 };
    switch (cls) {
      case 'INCOME_PLUS':
        s.income = add(s.income, tx.amount);
        s.incomeCount++;
        break;
      case 'INCOME_MINUS':
        s.income = sub(s.income, tx.amount);
        s.incomeCount++;
        break;
      case 'EXPENSE_PLUS':
        s.expense = add(s.expense, tx.amount);
        s.expenseCount++;
        break;
      case 'EXPENSE_MINUS':
        s.expense = sub(s.expense, tx.amount);
        s.expenseCount++;
        break;
    }
    byMonth.set(label, s);
  }
  return byMonth;
}

/**
 * Налог месяца: max(20 % × max(доход − расход, 0), 3 % × доход). Доход и расход
 * клампятся на 0 — возвраты не уводят базу в минус.
 */
export function ausnMonthTax(sums: AusnMonthSums | undefined): AusnMonthTax {
  const income = money(Prisma.Decimal.max(sums?.income ?? D(0), D(0)));
  const expense = money(Prisma.Decimal.max(sums?.expense ?? D(0), D(0)));
  const base = money(Prisma.Decimal.max(sub(income, expense), D(0)));
  const taxCalc = money(mul(base, AUSN_RATE));
  const taxMin = money(mul(income, AUSN_MIN_RATE));
  const taxDue = money(Prisma.Decimal.max(taxCalc, taxMin));
  return { income, expense, base, taxCalc, taxMin, taxDue };
}

/** Уплата налога: «Уплатить» (kind=TAX) или ЕНП из выписки статьёй группы «Налоги». */
export interface TaxPaymentRow {
  kind: TransactionKind;
  taxPeriod: string | null;
  amount: Prisma.Decimal;
  date: Date;
}

/**
 * Уплачено по месяцам налога «YYYY-MM». «Уплатить» несёт период явно; ЕНП из
 * выписки — по отметке периода, если она есть, иначе за месяц перед платежом.
 * На вход — только расходные операции уплаты, отбор делает вызывающий.
 */
export function taxPaidByPeriod(
  rows: TaxPaymentRow[],
  labels: ReadonlySet<string>,
): Map<string, Prisma.Decimal> {
  const paid = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    const label = r.kind === 'TAX' ? r.taxPeriod : (r.taxPeriod ?? inferredTaxPeriod(r.date));
    if (!label || !labels.has(label)) continue;
    paid.set(label, add(paid.get(label) ?? D(0), r.amount));
  }
  return paid;
}

/**
 * За какой месяц уплачен ЕНП, проведённый из выписки без отметки периода.
 * Налоговая присылает сумму АУСН за месяц не позднее 15-го числа следующего
 * месяца, срок уплаты — 25-е. Платёж с 15-го числа — налог за прошлый месяц
 * (25.08 → июль). Платёж до 15-го суммы прошлого месяца ещё не знает: это
 * доплата за позапрошлый (3 300 от 10.09 → июль, а не август — сверка
 * 27.09.2026, август бухгалтер заплатил 27.09 полной суммой). Операции
 * «Уплатить» несут taxPeriod явно — для них эта догадка не нужна.
 */
export function inferredTaxPeriod(paidAt: Date): string {
  const { y, mo, d } = businessDayParts(paidAt);
  const back = d < 15 ? 2 : 1;
  const idx = y * 12 + mo - back;
  const py = Math.floor(idx / 12);
  const pm = idx - py * 12;
  return `${py}-${String(pm + 1).padStart(2, '0')}`;
}
