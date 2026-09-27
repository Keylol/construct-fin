import { Prisma, type CategoryBucket, type CategoryKind, type TransactionKind } from '@prisma/client';
import { D, type Numeric } from '../common/money';
import { businessMonthLabel, resolvePeriod, type Period } from './period';

/**
 * Чистые функции «Итогов месяца»: группировка расходов ОПиУ по корневым
 * статьям, раскладка «из каждых 100 ₽» и «на один заказ» методом наибольших
 * остатков, границы месяца. Базы данных здесь нет — всё покрыто юнит-тестами
 * (month-summary.calc.test.ts).
 */

type Decimal = Prisma.Decimal;

// ───────────────────────────── Месяц ─────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthParts(month: string): { y: number; m: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`Месяц не в формате YYYY-MM: ${month}`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

/** Месяц «YYYY-MM», сдвинутый на delta месяцев (−1 — прошлый). */
export function shiftMonth(month: string, delta: number): string {
  const { y, m } = monthParts(month);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  return `${ny}-${String(idx - ny * 12 + 1).padStart(2, '0')}`;
}

/**
 * Границы месяца в поясе бизнеса (UTC+5): с 1-го числа 00:00 по последний
 * день 23:59:59.999 — через resolvePeriod, как у остальных отчётов.
 */
export function monthPeriod(month: string): Period {
  const { y, m } = monthParts(month);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return resolvePeriod({ from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` });
}

/** Прошлый законченный месяц бизнеса относительно момента now. */
export function lastClosedMonth(now: Date = new Date()): string {
  return shiftMonth(businessMonthLabel(now), -1);
}

// ─────────────────────── Группы расходов ───────────────────────

/**
 * Бакеты, расходы которых — «расходы месяца». Выручка и себестоимость идут
 * отдельными строками, закупки на склад и деньги владельца в прибыль не входят
 * (как в чистой прибыли ОПиУ).
 */
export const EXPENSE_GROUP_BUCKETS: ReadonlySet<CategoryBucket> = new Set<CategoryBucket>([
  'FIXED',
  'VARIABLE',
  'TAX',
  'OTHER',
]);

/** Группа для операций без статьи — по виду операции. */
export type SystemGroup = 'salary' | 'installments' | 'tax' | 'other';

export const SYSTEM_GROUP_NAME: Record<SystemGroup, string> = {
  salary: 'Зарплата',
  installments: 'Комиссии рассрочек',
  tax: 'Налог',
  other: 'Прочее',
};

export function systemGroupOf(kind: TransactionKind): SystemGroup {
  switch (kind) {
    case 'SALARY':
      return 'salary';
    // Без статьи VARIABLE_COST заводит оплата рассрочкой (комиссия банка) и
    // перевод с комиссией; статью эквайринга Входящие ставят сами.
    case 'VARIABLE_COST':
      return 'installments';
    case 'TAX':
      return 'tax';
    default:
      return 'other';
  }
}

export interface CategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  deletedAt: Date | null;
}

/**
 * Корень каждой живой статьи: поднимаемся по parentId, пока родитель жив.
 * Статья, чей родитель удалён, сама становится корнем. Удалённых статей в
 * ответе нет: их операции ОПиУ относит по виду, как операции без статьи.
 */
export function categoryRoots(categories: CategoryNode[]): Map<string, CategoryNode> {
  const alive = new Map(categories.filter((c) => !c.deletedAt).map((c) => [c.id, c]));
  const roots = new Map<string, CategoryNode>();
  for (const c of alive.values()) {
    let cur = c;
    const seen = new Set<string>([c.id]);
    while (cur.parentId) {
      const parent = alive.get(cur.parentId);
      if (!parent || seen.has(parent.id)) break; // защита от цикла в данных
      seen.add(parent.id);
      cur = parent;
    }
    roots.set(c.id, cur);
  }
  return roots;
}

const normName = (s: string) => s.trim().toLocaleLowerCase('ru-RU');

/** Строка ОПиУ, которой хватает группировке (подмножество PnlLine). */
export interface ExpenseLine {
  bucket: CategoryBucket;
  categoryId: string | null;
  kind: TransactionKind;
  expense: Numeric;
}

export interface ExpenseGroup {
  /** id корневой статьи либо имя системной группы (salary/installments/tax/other). */
  key: string;
  name: string;
  amount: Decimal;
  /** Статьи, чьи расходы вошли в группу, — для перехода к операциям. */
  categoryIds: string[];
  /** Виды операций без статьи, вошедшие в группу. */
  uncategorizedKinds: TransactionKind[];
  /** В группе начисленный налог АУСН (его нет в операциях — смотреть раздел «Налог»). */
  taxAccrual: boolean;
}

/**
 * Расходы месяца по группам. Группа — корневая статья: подстатьи сворачиваются
 * в свой корень. Операции без статьи (и с удалённой статьёй) — по виду:
 * зарплата → «Зарплата», комиссия рассрочки → «Комиссии рассрочек», прочие —
 * «Прочее». Начисленный налог АУСН идёт в «Налог». Системная группа сливается
 * с корневой статьёй того же имени («Зарплата» без статьи + статья «Зарплата»).
 * Учитываются только расходы бакетов EXPENSE_GROUP_BUCKETS; доходы тех же
 * бакетов — «прочие доходы», их считает вызывающий по byBucket.
 */
export function groupExpenses(input: {
  lines: ExpenseLine[];
  taxAccrued: Numeric;
  categories: CategoryNode[];
}): ExpenseGroup[] {
  const roots = categoryRoots(input.categories);
  // Расходная корневая статья по имени — для слияния с системной группой.
  // Доходная статья «Прочее» расходы без статьи к себе не забирает.
  const rootByName = new Map<string, CategoryNode>();
  for (const root of new Set(roots.values())) {
    if (root.kind !== 'EXPENSE') continue;
    const key = normName(root.name);
    if (!rootByName.has(key)) rootByName.set(key, root);
  }

  const groups = new Map<
    string,
    { key: string; name: string; amount: Decimal; categoryIds: Set<string>; kinds: Set<TransactionKind>; taxAccrual: boolean }
  >();
  const groupFor = (key: string, name: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, name, amount: D(0), categoryIds: new Set(), kinds: new Set(), taxAccrual: false };
      groups.set(key, g);
    }
    return g;
  };
  const systemGroup = (sys: SystemGroup) => {
    const merged = rootByName.get(normName(SYSTEM_GROUP_NAME[sys]));
    return merged ? groupFor(merged.id, merged.name) : groupFor(sys, SYSTEM_GROUP_NAME[sys]);
  };

  for (const line of input.lines) {
    if (!EXPENSE_GROUP_BUCKETS.has(line.bucket)) continue;
    const expense = D(line.expense);
    if (expense.isZero()) continue;
    const root = line.categoryId ? roots.get(line.categoryId) : undefined;
    if (root) {
      const g = groupFor(root.id, root.name);
      g.amount = g.amount.plus(expense);
      g.categoryIds.add(line.categoryId!);
    } else {
      const g = systemGroup(systemGroupOf(line.kind));
      g.amount = g.amount.plus(expense);
      g.kinds.add(line.kind);
    }
  }

  const tax = D(input.taxAccrued);
  if (!tax.isZero()) {
    const g = systemGroup('tax');
    g.amount = g.amount.plus(tax);
    g.taxAccrual = true;
  }

  return [...groups.values()].map((g) => ({
    key: g.key,
    name: g.name,
    amount: g.amount,
    categoryIds: [...g.categoryIds].sort(),
    uncategorizedKinds: [...g.kinds].sort(),
    taxAccrual: g.taxAccrual,
  }));
}

export interface ComparedGroup extends ExpenseGroup {
  prevAmount: Decimal;
}

/**
 * Группы месяца рядом с прошлым месяцем. Группа, которая была только в прошлом
 * месяце, остаётся строкой с нулём — видно, от чего расход ушёл. Порядок — по
 * убыванию суммы, при равенстве — по прошлому месяцу и по имени.
 */
export function compareGroups(current: ExpenseGroup[], prev: ExpenseGroup[]): ComparedGroup[] {
  const prevByKey = new Map(prev.map((g) => [g.key, g]));
  const out: ComparedGroup[] = current.map((g) => ({
    ...g,
    prevAmount: prevByKey.get(g.key)?.amount ?? D(0),
  }));
  const seen = new Set(current.map((g) => g.key));
  for (const p of prev) {
    if (seen.has(p.key)) continue;
    out.push({
      key: p.key,
      name: p.name,
      amount: D(0),
      categoryIds: [],
      uncategorizedKinds: [],
      taxAccrual: false,
      prevAmount: p.amount,
    });
  }
  return out.sort(
    (a, b) =>
      b.amount.comparedTo(a.amount) ||
      b.prevAmount.comparedTo(a.prevAmount) ||
      a.name.localeCompare(b.name, 'ru'),
  );
}

// ─────────────────── Округление для показа ───────────────────

/**
 * Метод наибольших остатков: округляет значения numerators[i] / denominator
 * до целых единиц так, чтобы сумма округлённых была ровно target. Каждое
 * значение сначала округляется вниз, недостающие единицы получают значения с
 * наибольшим дробным остатком (при равенстве — большее по модулю, затем
 * стоящее раньше). Работает и с отрицательными: floor(−2,35) = −3, остаток 0,65.
 *
 * Остатки считаются точно — числитель минус целая часть × знаменатель, без
 * деления: иначе равные остатки (20 000 и −1 000 при продажах 105 000) делило
 * бы округление 20-значной арифметики, и ничья решалась бы случайно.
 */
export function largestRemainder(
  numerators: Numeric[],
  target: Numeric,
  denominator: Numeric = 1,
): Decimal[] {
  const den = D(denominator);
  if (!den.greaterThan(0)) throw new Error('largestRemainder: знаменатель должен быть > 0');
  const nums = numerators.map((v) => D(v));
  const n = nums.length;
  if (n === 0) return [];
  const floors = nums.map((num) => {
    // Целая часть через деление, затем точная поправка по умножению.
    let f = num.div(den).floor();
    while (f.times(den).greaterThan(num)) f = f.minus(1);
    while (f.plus(1).times(den).lessThanOrEqualTo(num)) f = f.plus(1);
    return f;
  });
  const rems = nums.map((num, i) => num.minus(floors[i]!.times(den)));
  const order = nums
    .map((_, i) => i)
    .sort(
      (a, b) =>
        rems[b]!.comparedTo(rems[a]!) || nums[b]!.abs().comparedTo(nums[a]!.abs()) || a - b,
    );
  const out = floors.slice();
  let diff = D(target)
    .minus(floors.reduce((s, f) => s.plus(f), D(0)))
    .toNumber();
  // При target = округлённой сумме значений diff лежит в [0, n]; циклы ниже
  // держат и произвольный target.
  for (let k = 0; diff > 0; k++, diff--) {
    const i = order[k % n]!;
    out[i] = out[i]!.plus(1);
  }
  for (let k = 0; diff < 0; k++, diff++) {
    const i = order[n - 1 - (k % n)]!;
    out[i] = out[i]!.minus(1);
  }
  return out;
}

export interface ShareInput {
  sales: Numeric;
  components: Numeric;
  /** Суммы групп расходов в порядке показа. */
  groups: Numeric[];
  otherIncome: Numeric;
  net: Numeric;
  ordersClosed: number;
}

export interface ShareOutput {
  /** Рублей из каждых 100 ₽ продаж, строки с одним знаком; null — продаж нет. */
  per100: {
    components: string;
    markup: string;
    groups: string[];
    expenses: string;
    /** Положительное число: прочие доходы добавляют к прибыли. */
    otherIncome: string;
    net: string;
  } | null;
  /** Рублей на один закрытый заказ, целые; null — закрытых заказов нет. */
  perOrder: {
    sales: string;
    components: string;
    markup: string;
    groups: string[];
    expenses: string;
    otherIncome: string;
    net: string;
  } | null;
}

/**
 * Раскладка месяца для показа. Части — комплектующие, группы, прочие доходы
 * (со знаком минус: они уменьшают расходы) и прибыль. Их точная сумма равна
 * продажам (тождество ОПиУ), поэтому после наибольших остатков показанные
 * значения складываются ровно: 100 = комплектующие + Σгрупп − прочие доходы +
 * прибыль, и так же на один заказ. Если тождество не сходится, цель — сумма
 * самих частей: расхождение не маскируется подгонкой под продажи.
 */
export function computeShares(input: ShareInput): ShareOutput {
  const sales = D(input.sales);
  const parts = [
    D(input.components),
    ...input.groups.map((g) => D(g)),
    D(input.otherIncome).negated(),
    D(input.net),
  ];
  const partsSum = parts.reduce((s, p) => s.plus(p), D(0));
  const nGroups = input.groups.length;

  // Части обратно по местам: [комплектующие, …группы, −прочие доходы, прибыль].
  const split = (units: Decimal[], toText: (u: Decimal) => string) => {
    const groupUnits = units.slice(1, 1 + nGroups);
    return {
      comp: units[0]!,
      groups: groupUnits.map(toText),
      expenses: toText(groupUnits.reduce((s, u) => s.plus(u), D(0))),
      otherIncome: toText(units[1 + nGroups]!.negated()),
      net: toText(units[2 + nGroups]!),
    };
  };

  let per100: ShareOutput['per100'] = null;
  if (sales.greaterThan(0)) {
    // Единица — десятая доля рубля из 100 ₽ продаж: часть × 1000 / продажи.
    const units = largestRemainder(
      parts.map((p) => p.times(1000)),
      partsSum.times(1000).div(sales).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
      sales,
    );
    const tenth = (u: Decimal) => u.div(10).toFixed(1);
    const s = split(units, tenth);
    per100 = {
      components: tenth(s.comp),
      markup: tenth(D(1000).minus(s.comp)),
      groups: s.groups,
      expenses: s.expenses,
      otherIncome: s.otherIncome,
      net: s.net,
    };
  }

  let perOrder: ShareOutput['perOrder'] = null;
  if (input.ordersClosed > 0) {
    const n = D(input.ordersClosed);
    const units = largestRemainder(
      parts,
      partsSum.div(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
      n,
    );
    const rub = (u: Decimal) => u.toFixed(0);
    const salesPerOrder = sales.div(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const s = split(units, rub);
    perOrder = {
      sales: rub(salesPerOrder),
      components: rub(s.comp),
      markup: rub(salesPerOrder.minus(s.comp)),
      groups: s.groups,
      expenses: s.expenses,
      otherIncome: s.otherIncome,
      net: s.net,
    };
  }

  return { per100, perOrder };
}
