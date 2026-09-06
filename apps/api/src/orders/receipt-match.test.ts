import { describe, it, expect } from 'vitest';
import { matchCostsToItems, scoreCostPair, planCostApplication } from '@construct/shared';

/**
 * Названия взяты из живой папки клиента: спецификация CONSTRUCTPC и четыре чека
 * (ДНС, Wildberries, Онлайн Трейд). Это названия комплектующих — персональных
 * данных в них нет, в отличие от самих файлов.
 */

const ITEMS = [
  { name: 'Процессор: Intel Core i5-12400F' },
  { name: 'Видеокарта: GIGABYTE GeForce RTX 5060 Ti WINDFORCE' },
  { name: 'Материнская плата: MSI PRO H610M-G WIFI DDR4' },
  { name: 'Охлаждение: XASTRA AR400 ARGB' },
  { name: 'Оперативная память: 16Гб NETAC Shadow III 2x8Гб 3200МГц' },
  { name: 'Основной накопитель: 1000 ГБ M.2 NVMe накопитель Netac NV3000' },
  { name: 'Блок питания: 1STPLAYER ACK BRONZE, 650W, 80+ Bronze, ATX 3.1' },
  { name: 'Корпус: Powercase Alisio Micro Z3B ARGB V2, черный' },
  { name: 'Вентиляторы: 3 шт. вентиляторов ARGB' },
];

const LINES = [
  {
    name: 'Видеокарта PCI-E Gigabyte GeForce RTX 5060TI WINDFORCE MAX 8192MB 128b',
    unitPrice: '39499',
  },
  { name: 'Плата MSI LGA1700 H610 PRO H610M-G WIFI DDR4 2xDDR4 PCI-Ex16', unitPrice: '8199' },
  { name: 'Intel Core i5 12400F 6 ядер Процессор для ПК OEM', unitPrice: '10287.00' },
  { name: 'обработку получению SSD диск Netac NV3000, 1000GB, M.2 2280, PCIe 3.0', unitPrice: '14850' },
  { name: 'Блок питания 1STPLAYER ACK BRONZE, 650W, 80+ Bronze, ATX 3.1 (HA-650AA)', unitPrice: '3950' },
  { name: 'Кулер для процессора XASTRA AR400 ARGB Basic (AR400-XXAFPB-GL)', unitPrice: '1450' },
  { name: 'Корпус Powercase Alisio Micro Z3B ARGB V2, черный (CAMZB-A3-V2)', unitPrice: '3220' },
  {
    name: 'Оперативная память NETAC Shadow III 16Gb (2x8Gb) DDR4-3200 DIMM Black',
    unitPrice: '11950',
  },
];

describe('раскладка цен чеков по позициям заказа', () => {
  const matches = matchCostsToItems(ITEMS, LINES);
  const costByItem = new Map(matches.map((m) => [m.itemIndex, m.unitCost]));

  it('каждая строка чека находит свою позицию', () => {
    expect(matches).toHaveLength(8);
    expect(costByItem.get(0)).toBe('10287.00'); // процессор
    expect(costByItem.get(1)).toBe('39499'); // видеокарта
    expect(costByItem.get(2)).toBe('8199'); // материнская плата
    expect(costByItem.get(3)).toBe('1450'); // охлаждение
    expect(costByItem.get(4)).toBe('11950'); // память
    expect(costByItem.get(5)).toBe('14850'); // накопитель
    expect(costByItem.get(6)).toBe('3950'); // блок питания
    expect(costByItem.get(7)).toBe('3220'); // корпус
  });

  it('позиция со склада остаётся без цены — в чеках её нет', () => {
    expect(costByItem.has(8)).toBe(false);
  });

  it('«5060 Ti» в спецификации и «5060TI» в чеке — одно и то же', () => {
    const { score } = scoreCostPair(
      { name: 'Видеокарта: GIGABYTE GeForce RTX 5060 Ti WINDFORCE' },
      { name: 'Видеокарта PCI-E Gigabyte GeForce RTX 5060TI WINDFORCE MAX', unitPrice: '1' },
    );
    expect(score).toBeGreaterThan(0);
  });

  it('«Кулер для процессора» не прилипает к позиции «Процессор»', () => {
    const m = matchCostsToItems(
      [{ name: 'Процессор: Intel Core i5-12400F' }],
      [{ name: 'Кулер для процессора XASTRA AR400 ARGB Basic', unitPrice: '1450' }],
    );
    expect(m).toHaveLength(0);
  });

  it('одна строка чека не уходит в две позиции', () => {
    const m = matchCostsToItems(
      [
        { name: 'Основной накопитель: 1000 ГБ M.2 NVMe накопитель Netac NV3000' },
        { name: 'Второй накопитель: 1000 ГБ M.2 NVMe накопитель Netac NV3000' },
      ],
      [{ name: 'SSD диск Netac NV3000, 1000GB, M.2 2280', unitPrice: '14850' }],
    );
    expect(m).toHaveLength(1);
  });

  it('совсем чужая строка не предлагается', () => {
    const m = matchCostsToItems(
      [{ name: 'Процессор: Intel Core i5-12400F' }],
      [{ name: 'Доставка транспортной компанией', unitPrice: '500' }],
    );
    expect(m).toHaveLength(0);
  });

  it('причины объясняют совпадение человеку', () => {
    const { reasons } = scoreCostPair(ITEMS[5]!, LINES[3]!);
    expect(reasons.join(' ')).toContain('nv3000');
    expect(reasons.join(' ')).toMatch(/совпало слов/);
  });

  it('«5060» из сводного чека не подменяет «5060 Ti»', () => {
    // Обе строки лежат в одном чеке WB и различаются только суффиксом; цена
    // расходится на пять тысяч, и ошибка ушла бы в маржу молча.
    const items = [{ name: 'Видеокарта: GIGABYTE GeForce RTX 5060 Ti WINDFORCE OC 8G' }];
    const lines = [
      { name: 'Gigabyte Видеокарта NVIDIA GeForce RTX 5060 Windforce OC 8 ГБ', unitPrice: '27941.00' },
      { name: 'Gigabyte Видеокарта RTX 5060 Ti WINDFORCE OC, 8 Гб GDDR7', unitPrice: '32583.00' },
    ];
    expect(matchCostsToItems(items, lines)[0]?.unitCost).toBe('32583.00');
  });

  it('слитное «5060TI» в чеке — тот же товар, а не другой', () => {
    const items = [{ name: 'Видеокарта: GIGABYTE GeForce RTX 5060 Ti WINDFORCE OC' }];
    const lines = [
      { name: 'Видеокарта PCI-E Gigabyte GeForce RTX 5060TI WINDFORCE MAX 8192MB', unitPrice: '39499' },
    ];
    expect(matchCostsToItems(items, lines)).toHaveLength(1);
  });

  it('объём и частота — не модель: «16Гб» не роднит разные товары', () => {
    // Раньше «16гб» весила как артикул, и память цеплялась к любой строке с ним.
    const items = [{ name: 'Оперативная память: 16Гб Patriot Viper Venom DDR5 2x8Гб' }];
    const lines = [
      { name: 'Gigabyte Видеокарта RTX 5060 Ti WINDFORCE MAX OC 16Гб', unitPrice: '43240.00' },
      { name: 'Память DIMM DDR5 8192MBx2 5600MHz Patriot Viper Venom', unitPrice: '26399' },
    ];
    expect(matchCostsToItems(items, lines)[0]?.unitCost).toBe('26399');
  });

  it('количество из чека переносится в позицию, где стояла единица', () => {
    // Спецификация пишет «Вентиляторы: 3 шт.» одной строкой без количества.
    const plan = planCostApplication(
      [{ name: 'Вентиляторы: XASTRA FM120B ARGB', qty: '1', unitCost: '' }],
      [{ name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '590', qty: '3' }],
    );
    expect(plan.applications[0]).toMatchObject({ unitCost: '590', qty: '3', applied: true });
  });

  it('своё количество не перетирается количеством из чека', () => {
    const plan = planCostApplication(
      [{ name: 'Вентиляторы: XASTRA FM120B ARGB', qty: '5', unitCost: '' }],
      [{ name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '590', qty: '3' }],
    );
    expect(plan.applications[0]?.qty).toBe('5');
  });

  it('введённая руками закупка остаётся и в отчёт попадает как неприменённая', () => {
    const plan = planCostApplication(
      [{ name: 'Процессор: Intel Core i5-12400F', qty: '1', unitCost: '10000' }],
      [{ name: 'Intel Процессор Core i5-12400F OEM', unitPrice: '10545.00', qty: '1' }],
    );
    expect(plan.applications[0]?.applied).toBe(false);
    expect(plan.applications[0]?.reasons.join()).toContain('закупка уже заполнена');
    // Строка не считается использованной — человек видит её среди лишних.
    expect(plan.unusedLineIndexes).toEqual([0]);
  });
});

describe('комплект вентиляторов', () => {
  it('«вентиляторы» из спецификации совпадают с «вентилятор для корпуса» из чека', () => {
    const { score } = scoreCostPair(
      { name: 'Корпусные вентиляторы: 7 шт. ARGB вентиляторов' },
      { name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '409' },
    );
    expect(score).toBeGreaterThan(50);
  });

  it('комплект собирает все строки чека суммой, а не ценой одной штуки', () => {
    const plan = planCostApplication(
      [{ name: 'Корпусные вентиляторы: 7 шт. ARGB вентиляторов', qty: '1', unitCost: '' }],
      [
        { name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '409', qty: '1' },
        { name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '579', qty: '5' },
        { name: 'Вентилятор для корпуса Powercase M56-12 ARGB', unitPrice: '340', qty: '1' },
      ],
    );
    expect(plan.applications[0]?.unitCost).toBe('3644.00');
    expect(plan.applications[0]?.reasons.join(' ')).toContain('комплект');
    expect(plan.unusedLineIndexes).toHaveLength(0);
  });

  it('корпус с вентиляторами в одной позиции суммирует корпус и вентиляторы', () => {
    const plan = planCostApplication(
      [{ name: 'Корпус: Powercase Vision Micro M2 ARGB, белый + 4 шт. ARGB вентиляторов', qty: '1', unitCost: '' }],
      [
        { name: 'Корпус Powercase Vision Micro M2 ARGB, белый', unitPrice: '3890', qty: '1' },
        { name: 'Вентилятор для корпуса 1STPLAYER FN7 White OEM', unitPrice: '529', qty: '2' },
      ],
    );
    expect(plan.applications[0]?.unitCost).toBe('4948.00');
  });

  it('одиночный кулер процессора комплектом не считается', () => {
    const plan = planCostApplication(
      [{ name: 'Охлаждение: DEEPCOOL LE360 V2', qty: '1', unitCost: '' }],
      [
        { name: 'Кулер DEEPCOOL LE360 V2 ARGB 360мм черная', unitPrice: '4633', qty: '1' },
        { name: 'Вентилятор для корпуса XASTRA FM120B ARGB', unitPrice: '409', qty: '3' },
      ],
    );
    expect(plan.applications[0]?.unitCost).toBe('4633');
    expect(plan.unusedLineIndexes).toHaveLength(1);
  });

  it('стемминг не роднит разные модели на латинице', () => {
    const { score } = scoreCostPair(
      { name: 'Оперативная память: ADATA XPG Lancer Blade' },
      { name: 'Оперативная память ADATA XPG Lance', unitPrice: '1' },
    );
    const exact = scoreCostPair(
      { name: 'Оперативная память: ADATA XPG Lancer Blade' },
      { name: 'Оперативная память ADATA XPG Lancer Blade RGB', unitPrice: '1' },
    ).score;
    expect(score).toBeLessThan(exact);
  });
});
