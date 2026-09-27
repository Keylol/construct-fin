import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { add, money, D } from '../common/money';
import { yearPeriod, ausnDueDate, assertNotFuture } from './period';
import { AUSN_RATE, AUSN_MIN_RATE } from './ausn-classify';
import { ausnSumsByMonth, ausnMonthTax, taxPaidByPeriod } from './ausn-tax';

export interface TaxMonthRow {
  /** «YYYY-MM». */
  month: string;
  year: number;
  monthNo: number; // 1..12
  income: string;
  expense: string;
  /** База = max(доход − расход, 0). */
  base: string;
  /** Налог 20% с базы. */
  taxCalc: string;
  /** Минимальный налог 3% с доходов. */
  taxMin: string;
  /** К уплате = max(taxCalc, taxMin). */
  taxDue: string;
  /** Σ проведённых TAX-платежей за этот период. */
  taxPaid: string;
  /** Срок уплаты — 25-е следующего месяца (ISO). */
  dueDate: string;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'NONE';
  incomeCount: number;
  expenseCount: number;
}

export interface TaxYearReport {
  year: number;
  rate: number;
  minRate: number;
  months: TaxMonthRow[];
  totals: { income: string; expense: string; taxDue: string; taxPaid: string };
}

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Помесячный расчёт АУСН «Д−Р» за год. Один проход по операциям года:
   * классификатор относит каждую к доходу/расходу/вне базы (приоритет —
   * маркировка ausnMark, иначе авто по kind и группе статьи). Налог =
   * max(20%×база, 3%×доход) за месяц; «уплачено» — операции «Уплатить» с
   * taxPeriod=месяц и ЕНП из выписки (статья группы «Налоги»), отнесённые к
   * месяцу перед платежом.
   */
  async yearReport(workspaceId: string, year: number): Promise<TaxYearReport> {
    const period = yearPeriod(year);
    // ЕНП платится до 25-го следующего месяца: декабрьский налог уплачивают в
    // январе. Берём операции до конца января следующего года — для уплат;
    // база считается только по месяцам этого года (метки вне года не попадут).
    const paidHorizon = new Date(period.to.getTime() + 32 * 24 * 60 * 60_000);
    const txs = await this.prisma.transaction.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        date: { gte: period.from, lte: paidHorizon },
      },
      select: {
        type: true,
        kind: true,
        ausnMark: true,
        amount: true,
        date: true,
        taxPeriod: true,
        category: { select: { bucket: true, deletedAt: true } },
        account: { select: { type: true } },
      },
    });
    const inYear = txs.filter((t) => t.date <= period.to);
    const buckets = ausnSumsByMonth(
      inYear.map((t) => ({
        ...t,
        categoryBucket: t.category && !t.category.deletedAt ? t.category.bucket : null,
        accountType: t.account?.type ?? null,
      })),
    );

    // Уплаченный налог по периодам:
    //  • операции «Уплатить» (kind=TAX) несут taxPeriod явно;
    //  • ЕНП, проведённые из выписки статьёй группы «Налоги», периода не несут —
    //    относим их к месяцу перед платежом (срок АУСН — 25-е следующего месяца).
    //    Раньше такие платежи не считались уплатой вовсе, и «Налог к уплате» в
    //    Балансе рос на все уплаченные ЕНП (аудит 27.09).
    const labels = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const labelSet = new Set(labels);
    // «Уплатить» — по явному периоду, в какой бы день ни заплатили.
    const taxKindPaid = await this.prisma.transaction.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        kind: 'TAX',
        type: 'EXPENSE',
        taxPeriod: { in: labels },
      },
      select: { kind: true, taxPeriod: true, amount: true, date: true },
    });
    // ЕНП из выписки: статья группы «Налоги», вида не TAX.
    const bankEnp = txs.filter(
      (t) =>
        t.type === 'EXPENSE' &&
        t.kind !== 'TAX' &&
        !!t.category &&
        !t.category.deletedAt &&
        t.category.bucket === 'TAX',
    );
    const paidByPeriod = taxPaidByPeriod([...taxKindPaid, ...bankEnp], labelSet);

    const months: TaxMonthRow[] = labels.map((label, idx) => {
      const monthNo = idx + 1;
      const b = buckets.get(label);
      // Формула — общая с ОПиУ (ausn-tax.ts): доход/расход клампятся на 0.
      const { income, expense, base, taxCalc, taxMin, taxDue } = ausnMonthTax(b);
      const taxPaid = money(paidByPeriod.get(label) ?? D(0));

      let status: TaxMonthRow['status'];
      if (taxDue.isZero()) status = 'NONE';
      else if (taxPaid.greaterThanOrEqualTo(taxDue)) status = 'PAID';
      else if (taxPaid.greaterThan(0)) status = 'PARTIAL';
      else status = 'UNPAID';

      return {
        month: label,
        year,
        monthNo,
        income: income.toFixed(2),
        expense: expense.toFixed(2),
        base: base.toFixed(2),
        taxCalc: taxCalc.toFixed(2),
        taxMin: taxMin.toFixed(2),
        taxDue: taxDue.toFixed(2),
        taxPaid: taxPaid.toFixed(2),
        dueDate: ausnDueDate(year, monthNo).toISOString(),
        status,
        incomeCount: b?.incomeCount ?? 0,
        expenseCount: b?.expenseCount ?? 0,
      };
    });

    const totals = months.reduce(
      (acc, m) => ({
        income: add(acc.income, m.income),
        expense: add(acc.expense, m.expense),
        taxDue: add(acc.taxDue, m.taxDue),
        taxPaid: add(acc.taxPaid, m.taxPaid),
      }),
      { income: D(0), expense: D(0), taxDue: D(0), taxPaid: D(0) },
    );

    return {
      year,
      rate: AUSN_RATE,
      minRate: AUSN_MIN_RATE,
      months,
      totals: {
        income: money(totals.income).toFixed(2),
        expense: money(totals.expense).toFixed(2),
        taxDue: money(totals.taxDue).toFixed(2),
        taxPaid: money(totals.taxPaid).toFixed(2),
      },
    };
  }

  /**
   * Отметить уплату налога за месяц: создаёт TAX-расход с taxPeriod=«YYYY-MM».
   * Сумма и счёт задаются оператором (обычно = «к уплате»). Дата не в будущем.
   */
  async markPaid(
    workspaceId: string,
    userId: string,
    input: {
      year: number;
      month: number; // 1..12
      accountId: string;
      amount: string;
      date?: string;
      note?: string | null;
    },
  ) {
    if (input.month < 1 || input.month > 12) {
      throw new BadRequestException('Месяц должен быть 1..12');
    }
    if (!D(input.amount).greaterThan(0)) {
      throw new BadRequestException('Сумма налога должна быть положительной');
    }
    const acc = await this.prisma.account.findFirst({
      where: { id: input.accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw new NotFoundException('Счёт не найден в этой организации');

    const date = input.date ? new Date(input.date) : new Date();
    assertNotFuture(date, 'Дата уплаты налога');
    // taxPeriod — период, ЗА который платим налог (не дата платежа): налог за
    // февраль можно уплатить в марте (date=март, taxPeriod=«2026-02»).
    const label = `${input.year}-${String(input.month).padStart(2, '0')}`;

    return this.prisma.transaction.create({
      data: {
        workspaceId,
        accountId: input.accountId,
        date,
        amount: money(input.amount),
        type: 'EXPENSE',
        kind: 'TAX',
        taxPeriod: label,
        description: input.note?.trim() || `Налог АУСН за ${label}`,
        createdById: userId,
      },
      select: { id: true, taxPeriod: true, amount: true, date: true },
    });
  }

  /**
   * Ручное переопределение АУСН-классификации операции (доход/расход/не учит /
   * снять = null → авто по kind). Cross-tenant: операция обязана принадлежать ws.
   */
  async setAusnMark(
    workspaceId: string,
    transactionId: string,
    ausnMark: 'INCOME' | 'EXPENSE' | 'NOT_COUNTED' | null,
  ) {
    // Атомарный updateMany с workspaceId+deletedAt в WHERE (не findFirst→update):
    // иначе гонка с параллельным soft-delete могла бы обновить удалённую операцию.
    const res = await this.prisma.transaction.updateMany({
      where: { id: transactionId, workspaceId, deletedAt: null },
      data: { ausnMark },
    });
    if (res.count === 0) {
      throw new NotFoundException('Операция не найдена, удалена или из другой организации');
    }
    return { ok: true };
  }
}
