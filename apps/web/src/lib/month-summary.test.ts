import { describe, expect, it } from 'vitest';
import {
  barParts,
  businessMonth,
  deltaText,
  formatPer100,
  formatRubShort,
  isMonth,
  lastClosedMonth,
  monthDative,
  monthName,
  monthTitle,
  perOrderSteps,
  shiftMonth,
} from './month-summary';
import type { MonthSummaryGroup, MonthSummaryReport } from './types';

/** Неразрывные пробелы (Intl и наши единицы) → обычные: так проще сравнивать. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('месяц бизнеса (UTC+5)', () => {
  it('прошлый законченный месяц считается по Екатеринбургу, а не по браузеру', () => {
    // 1 сентября 00:30 по UTC+5 — в UTC ещё 31 августа.
    expect(businessMonth(new Date('2026-08-31T19:30:00.000Z'))).toBe('2026-09');
    expect(lastClosedMonth(new Date('2026-08-31T19:30:00.000Z'))).toBe('2026-08');
    expect(lastClosedMonth(new Date('2026-08-31T18:30:00.000Z'))).toBe('2026-07');
  });

  it('сдвиг через границу года и подписи месяца', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(monthTitle('2026-08')).toBe('Август 2026');
    expect(monthName('2026-08')).toBe('август');
    expect(monthDative('2026-07')).toBe('июлю');
    expect(isMonth('2026-08')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('август')).toBe(false);
  });
});

describe('суммы для текста', () => {
  it('млн, тыс. и рубли; «,0» в конце не пишем', () => {
    expect(plain(formatRubShort('3312456.00'))).toBe('3,3 млн ₽');
    expect(plain(formatRubShort('1000000.00'))).toBe('1 млн ₽');
    expect(plain(formatRubShort('214078.00'))).toBe('214 тыс. ₽');
    expect(plain(formatRubShort('48500.00'))).toBe('48,5 тыс. ₽');
    expect(plain(formatRubShort('48000.00'))).toBe('48 тыс. ₽');
    expect(plain(formatRubShort('950.40'))).toBe('950 ₽');
    expect(plain(formatRubShort('-1250000.00'))).toBe('−1,3 млн ₽');
  });

  it('рублей из 100: запятая, минус — в скобках', () => {
    expect(formatPer100('74.0')).toBe('74,0');
    expect(formatPer100('2.9')).toBe('2,9');
    expect(formatPer100('-3.0')).toBe('(3,0)');
  });

  it('изменение к прошлому месяцу', () => {
    expect(plain(deltaText('6636420.00', '5400000.00', '2026-07'))).toBe(
      '+1,2 млн ₽ (+23 %) к июлю',
    );
    expect(plain(deltaText('193383.00', '200000.00', '2026-07'))).toBe(
      '−6,6 тыс. ₽ (−3,3 %) к июлю',
    );
    // От убытка процент не считаем.
    expect(plain(deltaText('1000.00', '-5000.00', '2026-07'))).toBe('+6 тыс. ₽ к июлю');
    expect(deltaText('10.00', '10.00', '2026-07')).toBe('без изменений к июлю');
  });
});

function group(key: string, amount: string, perOrder: string, per100 = '0.0'): MonthSummaryGroup {
  return {
    key,
    name: key,
    amount,
    per100,
    perOrder,
    prevAmount: '0.00',
    categoryIds: [],
    uncategorizedKinds: [],
    taxAccrual: false,
  };
}

function report(over: Partial<MonthSummaryReport> = {}): MonthSummaryReport {
  return {
    month: '2026-08',
    from: '2026-07-31T19:00:00.000Z',
    to: '2026-08-31T18:59:59.999Z',
    ordersClosed: 31,
    sales: '6636420.00',
    components: '4912852.00',
    markup: '1723568.00',
    markupPct: '26.0',
    expenses: '1543185.00',
    otherIncome: '13000.00',
    net: '193383.00',
    netPct: '2.9',
    netPerOrder: '6238',
    per100: { components: '74.0', expenses: '23.3', otherIncome: '0.2' },
    perOrder: {
      sales: '214078',
      components: '158479',
      markup: '55599',
      expenses: '49780',
      otherIncome: '419',
    },
    groups: [
      group('Зарплата', '900000.00', '29032'),
      group('Маркетинг', '250000.00', '8065'),
      group('Налог', '199092.60', '6422'),
      group('Аренда', '150000.00', '4839'),
      group('Прочее', '44092.40', '1422'),
      group('Ремонт', '0.00', '0'),
    ],
    prev: {
      month: '2026-07',
      from: '',
      to: '',
      ordersClosed: 25,
      sales: '0.00',
      components: '0.00',
      markup: '0.00',
      expenses: '0.00',
      otherIncome: '0.00',
      net: '0.00',
    },
    checks: {
      identity: { ok: true, diff: '0.00' },
      inbox: { count: 0, incomeCount: 0, income: '0.00', expenseCount: 0, expense: '0.00' },
      ordersWithoutCost: { count: 0, orders: [] },
      openPrepaid: { count: 0, paid: '0.00' },
    },
    ...over,
  };
}

describe('полоса «из каждых 100 ₽»', () => {
  it('комплектующие, расходы за вычетом прочих доходов и прибыль — ровно 100', () => {
    const b = barParts(report())!;
    expect(b).toMatchObject({ components: '74.0', expenses: '23.1', net: '2.9' });
    expect(b.widths.reduce((s, w) => s + w, 0)).toBeCloseTo(100, 5);
  });

  it('убыток: у прибыли нет части полосы, комплектующие и расходы — больше 100', () => {
    const b = barParts(
      report({ per100: { components: '80.0', expenses: '25.0', otherIncome: '2.0' }, netPct: '-3.0' }),
    )!;
    expect(b.net).toBe('-3.0');
    expect(b.widths[2]).toBe(0);
    expect(b.widths[0] + b.widths[1]).toBeCloseTo(100, 5);
  });

  it('продаж нет — полосы нет', () => {
    expect(barParts(report({ per100: null, netPct: null }))).toBeNull();
  });
});

describe('на один компьютер', () => {
  it('крупнейшие группы отдельно, остальные одной строкой, пустые группы не показываем', () => {
    const steps = perOrderSteps(report())!;
    expect(steps.map((s) => [s.op, s.label, s.value])).toEqual([
      ['', 'Продажа', '214078'],
      ['−', 'Комплектующие', '158479'],
      ['=', 'Наценка', '55599'],
      ['−', 'Зарплата', '29032'],
      ['−', 'Маркетинг', '8065'],
      ['−', 'Налог', '6422'],
      ['−', 'Остальные расходы (2)', '6261'],
      ['+', 'Прочие доходы', '419'],
      ['=', 'Прибыль', '6238'],
    ]);
    // Шаги складываются: наценка − расходы + прочие доходы = прибыль.
    const byKey = new Map(steps.map((s) => [s.key, Number(s.value)]));
    const expenses = steps.filter((s) => s.op === '−' && s.key !== 'components');
    expect(
      byKey.get('markup')! - expenses.reduce((s, x) => s + Number(x.value), 0) + byKey.get('other')!,
    ).toBe(byKey.get('net'));
  });

  it('нет закрытых заказов — шагов нет', () => {
    expect(perOrderSteps(report({ perOrder: null, netPerOrder: null }))).toBeNull();
  });
});
