import { Prisma } from '@prisma/client';
import type { BreakdownReport } from '../breakdown.service';
import type { CashflowReport } from '../cashflow.service';
import type { PnlReport } from '../pnl.service';
import type { ReportTable } from './report-table';

export function pnlToTable(report: PnlReport): ReportTable {
  const columns = [
    { key: 'label', label: 'Период', kind: 'text' as const, width: 16 },
    { key: 'income', label: 'Доход', kind: 'money' as const, width: 16 },
    { key: 'expense', label: 'Расход', kind: 'money' as const, width: 16 },
    { key: 'net', label: 'Чистая прибыль', kind: 'money' as const, width: 18 },
  ];
  return {
    title: 'Прибыль и убытки (P&L)',
    period: report.primary.period,
    columns,
    rows: report.primary.buckets.map((b) => ({
      label: b.label,
      income: b.income,
      expense: b.expense,
      net: b.net,
    })),
    totals: {
      income: report.primary.totals.income,
      expense: report.primary.totals.expense,
      net: report.primary.totals.net,
    },
  };
}

export function cashflowToTable(report: CashflowReport): ReportTable {
  const columns = [
    { key: 'account', label: 'Счёт', kind: 'text' as const, width: 24 },
    { key: 'label', label: 'Период', kind: 'text' as const, width: 14 },
    { key: 'inflow', label: 'Приход', kind: 'money' as const, width: 16 },
    { key: 'outflow', label: 'Расход', kind: 'money' as const, width: 16 },
    { key: 'net', label: 'Чистый поток', kind: 'money' as const, width: 16 },
    { key: 'balance', label: 'Остаток', kind: 'money' as const, width: 16 },
  ];
  const rows: ReportTable['rows'] = [];
  let totalInflow = new Prisma.Decimal(0);
  let totalOutflow = new Prisma.Decimal(0);
  let totalNet = new Prisma.Decimal(0);
  for (const s of report.series) {
    for (const p of s.points) {
      rows.push({
        account: s.accountName,
        label: p.label,
        inflow: p.inflow,
        outflow: p.outflow,
        net: p.net,
        balance: p.balance,
      });
      // Деньги суммируем в Decimal по строкам-снимкам, не через Number.
      totalInflow = totalInflow.plus(p.inflow);
      totalOutflow = totalOutflow.plus(p.outflow);
      totalNet = totalNet.plus(p.net);
    }
  }
  return {
    title: 'Движение денежных средств (Cash flow)',
    period: report.period,
    columns,
    rows,
    // balance — нарастающий остаток (running balance), суммировать его по строкам
    // бессмысленно, поэтому в тоталах его не выводим (ячейка пустая).
    totals: {
      inflow: totalInflow.toFixed(2),
      outflow: totalOutflow.toFixed(2),
      net: totalNet.toFixed(2),
    },
  };
}

export function breakdownToTable(report: BreakdownReport, kind: 'category' | 'counterparty'): ReportTable {
  const columns = [
    { key: 'name', label: kind === 'category' ? 'Категория' : 'Контрагент', kind: 'text' as const, width: 30 },
    { key: 'count', label: 'Транзакций', kind: 'number' as const, width: 12 },
    { key: 'income', label: 'Доход', kind: 'money' as const, width: 16 },
    { key: 'expense', label: 'Расход', kind: 'money' as const, width: 16 },
    { key: 'total', label: 'Итого', kind: 'money' as const, width: 16 },
    { key: 'share', label: 'Доля', kind: 'percent' as const, width: 10 },
  ];
  const totalCount = report.rows.reduce((acc, r) => acc + r.count, 0);
  return {
    title: kind === 'category' ? 'Отчёт по категориям' : 'Отчёт по контрагентам',
    subtitle:
      report.type === 'ALL'
        ? 'Доход и расход'
        : report.type === 'INCOME'
        ? 'Только доход'
        : 'Только расход',
    period: report.period,
    columns,
    rows: report.rows.map((r) => ({
      name: r.name,
      count: r.count,
      income: r.income,
      expense: r.expense,
      total: r.total,
      share: r.share,
    })),
    totals: {
      count: totalCount,
      income: report.totalIncome,
      expense: report.totalExpense,
      total:
        report.type === 'INCOME'
          ? report.totalIncome
          : report.type === 'EXPENSE'
          ? report.totalExpense
          : (Number(report.totalIncome) + Number(report.totalExpense)).toFixed(2),
      share: 1,
    },
  };
}
