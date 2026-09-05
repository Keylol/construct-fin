import { describe, it, expect } from 'vitest';
import { matchCostsToItems, scoreCostPair } from '@construct/shared';

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
});
