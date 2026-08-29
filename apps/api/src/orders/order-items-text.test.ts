import { describe, it, expect } from 'vitest';
import { allocateSalePrices, parseOrderItemsText, D } from '@construct/shared';

describe('состав заказа из текста', () => {
  it('название, закупка и цена продажи через «/»', () => {
    const { items, errors } = parseOrderItemsText(
      'Процессор AMD Ryzen 7 9800X3D / 33202 / 55572.42\nВидеокарта Palit RTX 5080 / 124999 / 209225.99',
    );
    expect(errors).toEqual([]);
    expect(items).toEqual([
      {
        name: 'Процессор AMD Ryzen 7 9800X3D',
        qty: '1',
        unitCost: '33202.00',
        unitPrice: '55572.42',
      },
      { name: 'Видеокарта Palit RTX 5080', qty: '1', unitCost: '124999.00', unitPrice: '209225.99' },
    ]);
  });

  it('вставка из таблицы: разделитель — табуляция, сумма с пробелами и запятой', () => {
    const { items, errors } = parseOrderItemsText('Корпус LIAN LI Vector V100\t7 190,50');
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { name: 'Корпус LIAN LI Vector V100', qty: '1', unitCost: '7190.50', unitPrice: '' },
    ]);
  });

  it('только названия — цены заполнят позже', () => {
    const { items } = parseOrderItemsText('Сборка ПК\nНастройка BIOS');
    expect(items.map((i) => [i.name, i.unitCost])).toEqual([
      ['Сборка ПК', ''],
      ['Настройка BIOS', ''],
    ]);
  });

  it('количество берётся из хвоста названия', () => {
    const { items } = parseOrderItemsText('Вентилятор ARGB 120мм ×4 | 590\nПланка DDR5 x2 | 12000');
    expect(items.map((i) => [i.name, i.qty])).toEqual([
      ['Вентилятор ARGB 120мм', '4'],
      ['Планка DDR5', '2'],
    ]);
  });

  it('«×» внутри названия количеством не считается', () => {
    // «(2×32)» — раскладка планок, а не четыре штуки: множитель без пробела перед ним.
    const { items } = parseOrderItemsText('Оперативная память DDR5 64Гб (2×32) / 54990');
    expect(items[0]).toMatchObject({ name: 'Оперативная память DDR5 64Гб (2×32)', qty: '1' });
  });

  it('мусор в цене не теряется молча, а возвращается ошибкой', () => {
    const { items, errors } = parseOrderItemsText(
      'Процессор / 33202\nВидеокарта / около 125 тысяч\nКорпус / 7190',
    );
    expect(items.map((i) => i.name)).toEqual(['Процессор', 'Корпус']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2, reason: expect.stringContaining('не похоже на сумму') });
  });

  it('пустые строки пропускаются без ошибок', () => {
    const { items, errors } = parseOrderItemsText('\n  \nПроцессор / 33202\n\n');
    expect(items).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe('распределение цены продажи по позициям', () => {
  /** Сумма позиций: цена за единицу × количество. */
  const sumOf = (prices: string[], items: { qty: string; unitCost: string }[]) =>
    prices
      .reduce((acc, p, i) => acc.plus(D(p).times(D(items[i]?.qty ?? '0'))), D(0))
      .toFixed(2);

  it('раскидывает пропорционально закупке и сходится до копейки', () => {
    const items = [
      { qty: '1', unitCost: '33202' },
      { qty: '1', unitCost: '124999' },
      { qty: '1', unitCost: '25066' },
      { qty: '1', unitCost: '45799' },
      { qty: '1', unitCost: '9499' },
      { qty: '1', unitCost: '7190' },
    ];
    const prices = allocateSalePrices(items, '391478');
    expect(sumOf(prices, items)).toBe('391478.00');
    // Доля самой дорогой позиции — по её весу в закупке.
    expect(prices[1]).toBe('199118.46');
  });

  it('некруглый итог: копейки добирает последняя позиция', () => {
    const items = [
      { qty: '1', unitCost: '100' },
      { qty: '1', unitCost: '100' },
      { qty: '1', unitCost: '100' },
    ];
    const prices = allocateSalePrices(items, '100');
    expect(prices).toEqual(['33.33', '33.33', '33.34']);
    expect(sumOf(prices, items)).toBe('100.00');
  });

  it('количество больше единицы учитывается в весе и в цене за единицу', () => {
    const items = [
      { qty: '4', unitCost: '590' },
      { qty: '1', unitCost: '7640' },
    ];
    const prices = allocateSalePrices(items, '20000');
    expect(sumOf(prices, items)).toBe('20000.00');
    // Четыре вентилятора весят 2360 из 10000 закупки → 4720 на строку, 1180 за штуку.
    expect(prices[0]).toBe('1180.00');
  });

  it('без закупок делит поровну', () => {
    const items = [
      { qty: '1', unitCost: '' },
      { qty: '1', unitCost: '0' },
    ];
    expect(allocateSalePrices(items, '150')).toEqual(['75.00', '75.00']);
  });

  it('одна позиция получает весь итог', () => {
    expect(allocateSalePrices([{ qty: '1', unitCost: '0' }], '461468')).toEqual(['461468.00']);
  });

  it('пустой состав — пустой результат', () => {
    expect(allocateSalePrices([], '1000')).toEqual([]);
  });
});

describe('распределение: добирающая позиция без закупки', () => {
  /**
   * Живой случай (заказ Корнеевой, 9 позиций на 306 585): у последней позиции
   * закупки нет, а округление долей half-up давало сумму на копейку больше
   * итога — остаток уходил в минус, и заказ падал с 500 на стороне БД.
   */
  it('остаток не уходит в минус, сумма сходится', () => {
    const items = [
      { qty: '1', unitCost: '32312' },
      { qty: '1', unitCost: '88335' },
      { qty: '1', unitCost: '11907' },
      { qty: '1', unitCost: '4751' },
      { qty: '1', unitCost: '41999' },
      { qty: '1', unitCost: '14399' },
      { qty: '1', unitCost: '8499' },
      { qty: '1', unitCost: '7099' },
      { qty: '1', unitCost: '0' },
    ];
    const prices = allocateSalePrices(items, '306585');
    expect(prices.every((p) => Number(p) >= 0)).toBe(true);
    expect(prices[prices.length - 1]).toBe('0.04');
    const sum = prices.reduce((acc, p, i) => acc.plus(D(p).times(D(items[i]!.qty))), D(0));
    expect(sum.toFixed(2)).toBe('306585.00');
  });

  it('позиций больше, чем копеек в итоге — цены неотрицательны', () => {
    const items = Array.from({ length: 5 }, () => ({ qty: '1', unitCost: '1' }));
    const prices = allocateSalePrices(items, '0.03');
    expect(prices.every((p) => Number(p) >= 0)).toBe(true);
  });
});
