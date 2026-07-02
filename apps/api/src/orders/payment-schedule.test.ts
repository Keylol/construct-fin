import { describe, expect, it } from 'vitest';
import { D } from '../common/money';
import { scheduleView, type ScheduleEntryRecord } from './payment-schedule';

/**
 * Unit-тесты FIFO-покрытия графика платежей (F2).
 * Ключевая граница: просрочка наступает после КОНЦА дня dueDate в поясе
 * бизнеса UTC+5 — т.е. в 18:59:59.999Z того же календарного дня UTC.
 */

let seq = 0;
function entry(over: Partial<ScheduleEntryRecord> = {}): ScheduleEntryRecord {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    dueDate: new Date('2026-07-10T00:00:00.000Z'),
    amount: D('100.00'),
    note: null,
    ...over,
  };
}

// asOf по умолчанию: 2026-07-01 12:00 UTC (17:00 бизнес-дня) — до всех дефолтных сроков.
const NOW = new Date('2026-07-01T12:00:00.000Z');

describe('scheduleView — FIFO-покрытие', () => {
  it('нет графика → null', () => {
    expect(scheduleView([], D('0'), D('0'), NOW)).toBeNull();
  });

  it('оплата гасит строки по порядку дат: PAID → PARTIAL → PENDING', () => {
    const entries = [
      entry({ dueDate: new Date('2026-07-05T00:00:00.000Z'), amount: D('300.00') }),
      entry({ dueDate: new Date('2026-07-15T00:00:00.000Z'), amount: D('300.00') }),
      entry({ dueDate: new Date('2026-07-25T00:00:00.000Z'), amount: D('400.00') }),
    ];
    const v = scheduleView(entries, D('450.00'), D('1000.00'), NOW)!;
    expect(v.entries.map((e) => e.status)).toEqual(['PAID', 'PARTIAL', 'PENDING']);
    expect(v.entries.map((e) => e.covered)).toEqual(['300.00', '150.00', '0.00']);
    expect(v.entries.map((e) => e.remaining)).toEqual(['0.00', '150.00', '400.00']);
    expect(v.summary.matchesTotal).toBe(true);
    expect(v.summary.overdueAmount).toBe('0.00');
    // Следующий платёж — первая непогашенная (частичная) строка.
    expect(v.summary.nextDueDate).toBe('2026-07-15T00:00:00.000Z');
    expect(v.summary.nextDueAmount).toBe('150.00');
  });

  it('строки сортируются по дате, при равных датах — по seq', () => {
    const entries = [
      entry({ seq: 2, dueDate: new Date('2026-07-05T00:00:00.000Z'), amount: D('100.00') }),
      entry({ seq: 1, dueDate: new Date('2026-07-05T00:00:00.000Z'), amount: D('100.00') }),
    ];
    const v = scheduleView(entries, D('100.00'), D('200.00'), NOW)!;
    expect(v.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(v.entries.map((e) => e.status)).toEqual(['PAID', 'PENDING']);
  });

  it('переплата: все строки PAID, next = null', () => {
    const entries = [entry({ amount: D('100.00') }), entry({ amount: D('50.00') })];
    const v = scheduleView(entries, D('500.00'), D('150.00'), NOW)!;
    expect(v.entries.every((e) => e.status === 'PAID')).toBe(true);
    expect(v.summary.nextDueDate).toBeNull();
    expect(v.summary.nextDueAmount).toBeNull();
  });

  it('paidAmount < 0 (REFUNDED) покрытия не даёт', () => {
    const v = scheduleView([entry({ amount: D('100.00') })], D('-50.00'), D('100.00'), NOW)!;
    expect(v.entries[0]!.covered).toBe('0.00');
    expect(v.entries[0]!.status).toBe('PENDING');
  });
});

describe('scheduleView — просрочка (граница дня UTC+5)', () => {
  const due = new Date('2026-07-01T00:00:00.000Z'); // срок: день 2026-07-01

  it('в течение дня срока — ещё НЕ просрочен (18:59:59.999Z = 23:59 бизнес-дня)', () => {
    const v = scheduleView(
      [entry({ dueDate: due, amount: D('100.00') })],
      D('0'),
      D('100.00'),
      new Date('2026-07-01T18:59:59.999Z'),
    )!;
    expect(v.entries[0]!.status).toBe('PENDING');
    expect(v.summary.overdueAmount).toBe('0.00');
  });

  it('после конца бизнес-дня (19:00:00Z) — OVERDUE, остаток в overdueAmount', () => {
    const v = scheduleView(
      [entry({ dueDate: due, amount: D('100.00') })],
      D('40.00'),
      D('100.00'),
      new Date('2026-07-01T19:00:00.000Z'),
    )!;
    expect(v.entries[0]!.status).toBe('OVERDUE');
    expect(v.summary.overdueAmount).toBe('60.00'); // непокрытый остаток, не вся строка
  });

  it('просроченная, но полностью покрытая строка — PAID, в overdue не попадает', () => {
    const v = scheduleView(
      [entry({ dueDate: due, amount: D('100.00') })],
      D('100.00'),
      D('100.00'),
      new Date('2026-07-20T12:00:00.000Z'),
    )!;
    expect(v.entries[0]!.status).toBe('PAID');
    expect(v.summary.overdueAmount).toBe('0.00');
  });

  it('несколько просроченных строк суммируются', () => {
    const entries = [
      entry({ dueDate: new Date('2026-06-01T00:00:00.000Z'), amount: D('100.00') }),
      entry({ dueDate: new Date('2026-06-15T00:00:00.000Z'), amount: D('200.00') }),
      entry({ dueDate: new Date('2026-08-01T00:00:00.000Z'), amount: D('300.00') }),
    ];
    const v = scheduleView(entries, D('50.00'), D('600.00'), NOW)!;
    expect(v.entries.map((e) => e.status)).toEqual(['OVERDUE', 'OVERDUE', 'PENDING']);
    expect(v.summary.overdueAmount).toBe('250.00'); // (100−50) + 200
    // Следующий к оплате — первая непогашенная, даже если просрочена.
    expect(v.summary.nextDueDate).toBe('2026-06-01T00:00:00.000Z');
    expect(v.summary.nextDueAmount).toBe('50.00');
  });
});

describe('scheduleView — сводка', () => {
  it('matchesTotal=false при Σ ≠ totalAmount (мягкое предупреждение, не ошибка)', () => {
    const v = scheduleView([entry({ amount: D('100.00') })], D('0'), D('150.00'), NOW)!;
    expect(v.summary.planned).toBe('100.00');
    expect(v.summary.matchesTotal).toBe(false);
  });

  it('planned суммирует все строки', () => {
    const entries = [
      entry({ amount: D('100.50') }),
      entry({ amount: D('200.25') }),
      entry({ amount: D('0.25') }),
    ];
    const v = scheduleView(entries, D('0'), D('301.00'), NOW)!;
    expect(v.summary.planned).toBe('301.00');
    expect(v.summary.matchesTotal).toBe(true);
  });
});
