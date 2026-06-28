import { describe, expect, it } from 'vitest';
import { cashflowToTable } from './builders';
import type { CashflowReport } from '../cashflow.service';

/** Точка cashflow с дефолтами — переопределяем только нужные поля. */
function point(over: Partial<CashflowReport['series'][number]['points'][number]>) {
  return {
    label: '2026-01',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:59.999Z',
    inflow: '0.00',
    outflow: '0.00',
    net: '0.00',
    balance: '0.00',
    ...over,
  };
}

describe('cashflowToTable — totals', () => {
  it('суммирует inflow/outflow/net по всем точкам всех серий (Decimal, не Number)', () => {
    const report: CashflowReport = {
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-28T23:59:59.999Z' },
      series: [
        {
          accountId: 'a1',
          accountName: 'Карта',
          openingBalance: '0.00',
          points: [
            point({ inflow: '100.10', outflow: '40.05', net: '60.05', balance: '60.05' }),
            point({ label: '2026-02', inflow: '200.20', outflow: '50.00', net: '150.20', balance: '210.25' }),
          ],
        },
        {
          accountId: 'a2',
          accountName: 'Касса',
          openingBalance: '0.00',
          points: [point({ inflow: '0.70', outflow: '0.00', net: '0.70', balance: '0.70' })],
        },
      ],
    };

    const table = cashflowToTable(report);
    expect(table.totals).toEqual({
      inflow: '301.00', // 100.10 + 200.20 + 0.70
      outflow: '90.05', // 40.05 + 50.00 + 0.00
      net: '210.95', // 60.05 + 150.20 + 0.70
    });
    // running balance не суммируется → отсутствует в тоталах (пустая ячейка).
    expect(table.totals!.balance).toBeUndefined();
  });

  it('пустой отчёт → нулевые тоталы', () => {
    const report: CashflowReport = {
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
      series: [],
    };
    const table = cashflowToTable(report);
    expect(table.rows).toHaveLength(0);
    expect(table.totals).toEqual({ inflow: '0.00', outflow: '0.00', net: '0.00' });
  });
});
