import { describe, expect, it } from 'vitest';
import type { CategoryBucket, Prisma, TransactionKind } from '@prisma/client';
import { D } from '../common/money';
import { enumerateMonths, isWholeMonth } from './period';
import {
  compareGroups,
  computeShares,
  groupExpenses,
  largestRemainder,
  lastClosedMonth,
  monthPeriod,
  shiftMonth,
  type CategoryNode,
  type ExpenseLine,
} from './month-summary.calc';

const sumOf = (xs: Array<string | Prisma.Decimal>): Prisma.Decimal =>
  xs.reduce<Prisma.Decimal>((s, x) => s.plus(x), D(0));

describe('largestRemainder', () => {
  it('сумма округлённых равна цели, лишняя единица — наибольшему остатку', () => {
    const out = largestRemainder(['33.33', '33.33', '33.34'], 100);
    expect(out.map(String)).toEqual(['33', '33', '34']);
    expect(sumOf(out).toString()).toBe('100');
  });

  it('отрицательная часть (прочие доходы со знаком минус) округляется вниз и получает единицу по остатку', () => {
    // 740,3 + 232,1 − 1,96 + 29,56 = 1000: floor → 740 + 232 − 2 + 29 = 999,
    // недостающую единицу получает наибольший остаток (0,56 у прибыли).
    const out = largestRemainder(['740.3', '232.1', '-1.96', '29.56'], 1000);
    expect(out.map(String)).toEqual(['740', '232', '-2', '30']);
    expect(sumOf(out).toString()).toBe('1000');
  });

  it('при равных остатках единица достаётся большему по модулю', () => {
    // floor: 1 + 10 = 11, до цели 12 не хватает одной единицы.
    const out = largestRemainder(['1.5', '10.5'], 12);
    expect(out.map(String)).toEqual(['1', '11']);
  });

  it('ничья остатков при общем знаменателе решается точно, а не округлением деления', () => {
    // 20 000 000 / 105 000 = 190,476… и −1 000 000 / 105 000 = −9,523…: остатки
    // равны ровно (50 000 / 105 000). Единица — большему по модулю.
    const out = largestRemainder(['20000000', '-1000000'], 181, '105000');
    expect(out.map(String)).toEqual(['191', '-10']);
  });

  it('держит и цель ниже суммы округлённых вниз', () => {
    const out = largestRemainder(['5.2', '5.9'], 9);
    expect(sumOf(out).toString()).toBe('9');
  });

  it('пустой набор — пустой ответ', () => {
    expect(largestRemainder([], 0)).toEqual([]);
  });
});

describe('computeShares', () => {
  // Август 2026 (ИП Каменский) из презентации владельцу: продажи 6 636 420,
  // комплектующие 4 912 852, прочие доходы 13 000, прибыль 193 383, 31 заказ.
  // Расходы разложены по группам так, чтобы тождество сходилось.
  const august = {
    sales: '6636420.00',
    components: '4912852.00',
    groups: ['900000.00', '250000.00', '199092.60', '150000.00', '44092.40'],
    otherIncome: '13000.00',
    net: '193383.00',
    ordersClosed: 31,
  };

  it('из каждых 100 ₽: показанные части складываются ровно в 100', () => {
    const { per100 } = computeShares(august);
    expect(per100).not.toBeNull();
    expect(per100!.components).toBe('74.0');
    expect(per100!.markup).toBe('26.0');
    expect(per100!.net).toBe('2.9');
    expect(per100!.otherIncome).toBe('0.2');
    // 100 = комплектующие + Σ групп − прочие доходы + прибыль
    const total = D(per100!.components)
      .plus(sumOf(per100!.groups))
      .minus(per100!.otherIncome)
      .plus(per100!.net);
    expect(total.toFixed(1)).toBe('100.0');
    expect(per100!.expenses).toBe(sumOf(per100!.groups).toFixed(1));
    // Наценка на 100 ₽ = расходы − прочие доходы + прибыль на 100 ₽.
    expect(
      D(per100!.expenses).minus(per100!.otherIncome).plus(per100!.net).toFixed(1),
    ).toBe(per100!.markup);
  });

  it('на один заказ: продажа = комплектующие + расходы − прочие доходы + прибыль, в рублях', () => {
    const { perOrder } = computeShares(august);
    expect(perOrder).not.toBeNull();
    expect(perOrder!.sales).toBe('214078'); // 6 636 420 / 31 = 214 078,06
    expect(perOrder!.net).toBe('6238'); // 193 383 / 31 = 6 238,16
    expect(perOrder!.otherIncome).toBe('419'); // 13 000 / 31 = 419,35
    const total = D(perOrder!.components)
      .plus(sumOf(perOrder!.groups))
      .minus(perOrder!.otherIncome)
      .plus(perOrder!.net);
    expect(total.toString()).toBe(perOrder!.sales);
    expect(D(perOrder!.sales).minus(perOrder!.components).toString()).toBe(perOrder!.markup);
    expect(perOrder!.markup).toBe('55599'); // 1 723 568 / 31 = 55 598,97
  });

  it('прочие доходы больше нуля и убыток: знаки сохраняются, сумма сходится', () => {
    // Продажи 1000, комплектующие 800, расходы 250, прочие доходы 20, убыток −30.
    const res = computeShares({
      sales: '1000.00',
      components: '800.00',
      groups: ['150.00', '100.00'],
      otherIncome: '20.00',
      net: '-30.00',
      ordersClosed: 3,
    });
    expect(res.per100!.net).toBe('-3.0');
    expect(res.per100!.otherIncome).toBe('2.0');
    const total = D(res.per100!.components)
      .plus(res.per100!.expenses)
      .minus(res.per100!.otherIncome)
      .plus(res.per100!.net);
    expect(total.toFixed(1)).toBe('100.0');
    // 1000 / 3 = 333,33 → 333; части: 266,67 + 50 + 33,33 − 6,67 − 10.
    const po = res.perOrder!;
    expect(po.sales).toBe('333');
    expect(
      D(po.components).plus(po.expenses).minus(po.otherIncome).plus(po.net).toString(),
    ).toBe('333');
  });

  it('отрицательные прочие доходы (возвраты в статьях расходов) тоже сходятся', () => {
    const res = computeShares({
      sales: '999.99',
      components: '333.33',
      groups: ['333.33'],
      otherIncome: '-0.01',
      net: '333.32',
      ordersClosed: 7,
    });
    const p = res.per100!;
    expect(D(p.components).plus(p.expenses).minus(p.otherIncome).plus(p.net).toFixed(1)).toBe(
      '100.0',
    );
    const po = res.perOrder!;
    expect(D(po.components).plus(po.expenses).minus(po.otherIncome).plus(po.net).toString()).toBe(
      po.sales,
    );
  });

  it('нет продаж — нет долей; нет закрытых заказов — нет раскладки на заказ', () => {
    const res = computeShares({
      sales: '0.00',
      components: '0.00',
      groups: ['5000.00'],
      otherIncome: '0.00',
      net: '-5000.00',
      ordersClosed: 0,
    });
    expect(res.per100).toBeNull();
    expect(res.perOrder).toBeNull();
  });

  it('тождество не сходится — части не подгоняются под 100', () => {
    // Прибыль «ошиблась» на 100 ₽ из 1000: части дают 110 ₽ со 100.
    const res = computeShares({
      sales: '1000.00',
      components: '500.00',
      groups: ['300.00'],
      otherIncome: '0.00',
      net: '300.00',
      ordersClosed: 1,
    });
    const p = res.per100!;
    expect(D(p.components).plus(p.expenses).plus(p.net).toFixed(1)).toBe('110.0');
  });
});

// ─────────────────────── Группировка ───────────────────────

function cat(
  id: string,
  name: string,
  parentId: string | null = null,
  extra: Partial<CategoryNode> = {},
): CategoryNode {
  return { id, name, parentId, kind: 'EXPENSE', deletedAt: null, ...extra };
}

function line(
  bucket: CategoryBucket,
  categoryId: string | null,
  kind: TransactionKind,
  expense: string,
): ExpenseLine {
  return { bucket, categoryId, kind, expense };
}

const byKey = <T extends { key: string }>(xs: T[]) => new Map(xs.map((x) => [x.key, x]));

describe('groupExpenses', () => {
  const categories = [
    cat('mkt', 'Маркетинг'),
    cat('ads', 'Реклама', 'mkt'),
    cat('promo', 'Розыгрыши', 'mkt'),
    cat('rent', 'Аренда'),
    cat('warranty', 'Гарантия'),
  ];

  it('подстатьи сворачиваются в корневую статью', () => {
    const groups = groupExpenses({
      lines: [
        line('VARIABLE', 'ads', 'OTHER', '1000.00'),
        line('FIXED', 'promo', 'OTHER', '500.00'), // бакет у подстатьи свой — группа та же
        line('FIXED', 'mkt', 'FIXED_COST', '200.00'),
        line('FIXED', 'rent', 'FIXED_COST', '3000.00'),
      ],
      taxAccrued: '0',
      categories,
    });
    const g = byKey(groups);
    expect(g.get('mkt')!.name).toBe('Маркетинг');
    expect(g.get('mkt')!.amount.toFixed(2)).toBe('1700.00');
    expect(g.get('mkt')!.categoryIds).toEqual(['ads', 'mkt', 'promo']);
    expect(g.get('rent')!.amount.toFixed(2)).toBe('3000.00');
    expect(groups).toHaveLength(2);
  });

  it('операции без статьи — по виду: зарплата, комиссии рассрочек, прочее', () => {
    const groups = groupExpenses({
      lines: [
        line('FIXED', null, 'SALARY', '50000.00'),
        line('VARIABLE', null, 'VARIABLE_COST', '1200.00'),
        line('OTHER', null, 'OTHER', '300.00'),
        line('OTHER', null, 'NON_OP', '100.00'),
        line('FIXED', null, 'FIXED_COST', '50.00'),
      ],
      taxAccrued: '0',
      categories,
    });
    const g = byKey(groups);
    expect(g.get('salary')).toMatchObject({ name: 'Зарплата', uncategorizedKinds: ['SALARY'] });
    expect(g.get('salary')!.amount.toFixed(2)).toBe('50000.00');
    expect(g.get('installments')!.name).toBe('Комиссии рассрочек');
    expect(g.get('installments')!.amount.toFixed(2)).toBe('1200.00');
    expect(g.get('other')!.name).toBe('Прочее');
    expect(g.get('other')!.amount.toFixed(2)).toBe('450.00');
    expect(g.get('other')!.uncategorizedKinds).toEqual(['FIXED_COST', 'NON_OP', 'OTHER']);
  });

  it('зарплата без статьи сливается с корневой статьёй «Зарплата»', () => {
    const groups = groupExpenses({
      lines: [
        line('FIXED', 'sal-mgr', 'SALARY', '40000.00'),
        line('FIXED', null, 'SALARY', '60000.00'),
      ],
      taxAccrued: '0',
      categories: [...categories, cat('sal', ' зарплата '), cat('sal-mgr', 'Менеджеры', 'sal')],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'sal',
      name: ' зарплата ',
      categoryIds: ['sal-mgr'],
      uncategorizedKinds: ['SALARY'],
    });
    expect(groups[0]!.amount.toFixed(2)).toBe('100000.00');
  });

  it('начисленный налог АУСН — группа «Налог» с отметкой taxAccrual', () => {
    const groups = groupExpenses({ lines: [], taxAccrued: '1600.00', categories });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'tax', name: 'Налог', taxAccrual: true });
    expect(groups[0]!.amount.toFixed(2)).toBe('1600.00');
  });

  it('закупки, деньги владельца, выручка и себестоимость в группы не попадают', () => {
    const groups = groupExpenses({
      lines: [
        line('PURCHASES', null, 'PURCHASE', '70000.00'),
        line('CAPITAL', null, 'CAPITAL_OUT', '20000.00'),
        line('REVENUE', null, 'ORDER_REFUND', '1000.00'),
        line('COGS', 'warranty', 'OTHER', '4000.00'),
        line('COGS', null, 'WRITE_OFF', '500.00'),
      ],
      taxAccrued: '0',
      categories,
    });
    expect(groups).toEqual([]);
  });

  it('удалённая статья — по виду операции; статья без живого родителя — сама себе корень', () => {
    const groups = groupExpenses({
      lines: [
        line('FIXED', 'gone', 'SALARY', '700.00'),
        line('VARIABLE', 'orphan', 'OTHER', '90.00'),
      ],
      taxAccrued: '0',
      categories: [
        ...categories,
        cat('gone', 'Старая статья', null, { deletedAt: new Date() }),
        cat('dead-parent', 'Удалённый родитель', null, { deletedAt: new Date() }),
        cat('orphan', 'Сирота', 'dead-parent'),
      ],
    });
    const g = byKey(groups);
    expect(g.get('salary')!.amount.toFixed(2)).toBe('700.00');
    expect(g.get('salary')!.categoryIds).toEqual([]);
    expect(g.get('orphan')!.name).toBe('Сирота');
  });

  it('доходные строки без расхода группу не создают', () => {
    const groups = groupExpenses({
      lines: [line('OTHER', 'rent', 'OTHER', '0.00')],
      taxAccrued: '0',
      categories,
    });
    expect(groups).toEqual([]);
  });
});

describe('compareGroups', () => {
  it('прошлый месяц рядом; группа только прошлого месяца — строкой с нулём; порядок по сумме', () => {
    const cur = groupExpenses({
      lines: [
        line('FIXED', 'rent', 'FIXED_COST', '3000.00'),
        line('FIXED', null, 'SALARY', '9000.00'),
      ],
      taxAccrued: '0',
      categories: [cat('rent', 'Аренда'), cat('repair', 'Ремонт')],
    });
    const prev = groupExpenses({
      lines: [
        line('FIXED', 'rent', 'FIXED_COST', '2500.00'),
        line('OTHER', 'repair', 'OTHER', '400.00'),
      ],
      taxAccrued: '0',
      categories: [cat('rent', 'Аренда'), cat('repair', 'Ремонт')],
    });
    const rows = compareGroups(cur, prev);
    expect(rows.map((r) => r.key)).toEqual(['salary', 'rent', 'repair']);
    expect(rows[0]!.prevAmount.toFixed(2)).toBe('0.00');
    expect(rows[1]!.prevAmount.toFixed(2)).toBe('2500.00');
    expect(rows[2]!.amount.toFixed(2)).toBe('0.00');
    expect(rows[2]!.prevAmount.toFixed(2)).toBe('400.00');
    expect(rows[2]!.categoryIds).toEqual([]);
  });
});

describe('месяц', () => {
  it('shiftMonth переходит через границу года', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-08', 0)).toBe('2026-08');
  });

  it('monthPeriod — целый месяц в поясе бизнеса (UTC+5)', () => {
    const p = monthPeriod('2026-08');
    expect(p.from.toISOString()).toBe('2026-07-31T19:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-08-31T18:59:59.999Z');
    const months = enumerateMonths(p);
    expect(months.map((m) => m.label)).toEqual(['2026-08']);
    expect(isWholeMonth(months[0]!)).toBe(true);
    // Февраль високосного года — 29 дней.
    expect(monthPeriod('2028-02').to.toISOString()).toBe('2028-02-29T18:59:59.999Z');
  });

  it('lastClosedMonth — прошлый месяц по часам бизнеса, а не сервера', () => {
    // 1 сентября 00:30 по UTC+5 — на сервере в UTC ещё 31 августа.
    expect(lastClosedMonth(new Date('2026-08-31T19:30:00.000Z'))).toBe('2026-08');
    expect(lastClosedMonth(new Date('2026-08-31T18:30:00.000Z'))).toBe('2026-07');
  });
});
