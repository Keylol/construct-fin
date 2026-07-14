import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWbReceiptPdf, splitReceiptSums } from './receipt-parser';

const FIXTURES = resolve(__dirname, '../../../../fixtures/imports');
// Реальные чеки/выписки (персональные данные) НЕ коммитятся — лежат локально в
// fixtures/imports/private/ (.gitignore). В CI эти блоки скипаются; синтетика
// (wb-receipt-synth.pdf, сгенерена cupsfilter из текста с теми же паттернами)
// покрывает все краевые случаи формата и гоняется везде.
const PRIVATE = resolve(FIXTURES, 'private');
const hasPrivate = existsSync(resolve(PRIVATE, 'wb-receipt-1.pdf'));

const load = (name: string) => readFileSync(resolve(FIXTURES, name));
const loadPrivate = (name: string) => readFileSync(resolve(PRIVATE, name));

describe('splitReceiptSums', () => {
  it('развязывает склейку цена+кол-во+сумма по инварианту', () => {
    expect(splitReceiptSums('590.001590.00')).toEqual({
      unitPrice: '590.00',
      qty: '1',
      lineTotal: '590.00',
    });
    expect(splitReceiptSums('34334.00134334.00')).toEqual({
      unitPrice: '34334.00',
      qty: '1',
      lineTotal: '34334.00',
    });
    // Кол-во > 1: 5.00 × 15 = 75.00 → «5.001575.00»
    expect(splitReceiptSums('5.001575.00')).toEqual({
      unitPrice: '5.00',
      qty: '15',
      lineTotal: '75.00',
    });
  });

  it('читает вариант с пробелами напрямую', () => {
    expect(splitReceiptSums('590.00 1 590.00')).toEqual({
      unitPrice: '590.00',
      qty: '1',
      lineTotal: '590.00',
    });
  });

  it('возвращает null на неразвязываемой строке', () => {
    expect(splitReceiptSums('не суммы')).toBeNull();
    // 10.00 × 3 ≠ 999.00 — инвариант не сходится ни при одном разрезе
    expect(splitReceiptSums('10.003999.00')).toBeNull();
  });
});

describe('parseWbReceiptPdf (синтетика)', () => {
  it('чек-синт: группировка штук, разрыв страницы, имя с цифры, два WB-заказа', async () => {
    const res = await parseWbReceiptPdf(load('wb-receipt-synth.pdf'));

    expect(res.receiptDate?.toISOString()).toBe('2026-05-21T03:25:00.000Z');
    expect(res.checkNumber).toBe('1471');
    expect(res.fd).toBe('16669');
    expect(res.fpd).toBe('1234567890');
    expect(res.totalAmount).toBe('27226.00');
    expect(res.paidElectronic).toBe('27226.00');

    // 5 поштучных строк → 3 сгруппированных позиции.
    expect(res.items).toHaveLength(3);
    const [fans, psu, cpu] = res.items;

    expect(fans?.name).toContain('Вентилятор корпусной');
    expect(fans?.qty).toBe('3');
    expect(fans?.unitPrice).toBe('590.00');
    expect(fans?.lineTotal).toBe('1770.00');
    // Блок «ИНН продавца + имя» третьей штуки уехал за разрыв страницы (футер).
    expect(fans?.sellerInn).toBe('1111111111');
    expect(fans?.sellerName).toBe('ООО "ПРОДАВЕЦ ОДИН"');
    expect(fans?.unitCodes).toHaveLength(3);

    // Номер позиции склеен с именем, начинающимся с цифры: «41stCorp…» = поз. 4.
    expect(psu?.name).toBe('1stCorp Блок питания 850W (тест)');
    expect(psu?.qty).toBe('1');
    expect(psu?.unitPrice).toBe('7018.00');
    expect(psu?.sellerName).toBe('ОНЛАЙН МАГАЗИН ООО (тест)');

    // «Без НДС» + иностранный продавец с нулевым ИНН.
    expect(cpu?.name).toContain('Процессор для ПК');
    expect(cpu?.unitPrice).toBe('18438.00');
    expect(cpu?.sellerInn).toBe('000000000000');
    expect(cpu?.sellerName).toBe('海外賣家有限公司');

    // Один чек несёт позиции из ДВУХ разных WB-заказов (разные хэши кода).
    const hashes = new Set(res.items.map((i) => i.wbOrderHash));
    expect(hashes.size).toBe(2);
    expect(cpu?.wbOrderHash).not.toBe(fans?.wbOrderHash);

    // Σ позиций == Итого — предупреждений нет.
    expect(res.warnings).toEqual([]);
  });

  it('не-чек: возвращает предупреждение, а не мусор', async () => {
    // Выписка ВБ-банка — валидный PDF, но не кассовый чек.
    const res = await parseWbReceiptPdf(load('wb-statement-synth.pdf'));
    expect(res.items).toHaveLength(0);
    expect(res.warnings.join(' ')).toContain('не похоже на кассовый чек');
  });
});

// Реальные чеки — только локально (fixtures/imports/private/, вне гита).
describe.skipIf(!hasPrivate)('parseWbReceiptPdf (реальные чеки, локально)', () => {
  it('чек-1: группирует поштучные строки, читает шапку/итоги/продавцов', async () => {
    const res = await parseWbReceiptPdf(loadPrivate('wb-receipt-1.pdf'));

    expect(res.receiptDate?.toISOString()).toBe('2026-05-21T03:25:00.000Z');
    expect(res.checkNumber).toBe('1471');
    expect(res.fd).toBe('16669');
    expect(res.fpd).toBe('3910731882');
    expect(res.totalAmount).toBe('26705.00');
    expect(res.paidElectronic).toBe('26705.00');

    // 14 поштучных строк чека → 5 сгруппированных позиций.
    expect(res.items).toHaveLength(5);
    const [fansRev, fansFwd, psu1, aio, psu2] = res.items;

    expect(fansRev?.name).toContain('Transwarp REVERSE');
    expect(fansRev?.qty).toBe('6');
    expect(fansRev?.unitPrice).toBe('590.00');
    expect(fansRev?.lineTotal).toBe('3540.00');
    expect(fansRev?.sellerName).toBe('ООО "АЛЬЯНС МЕДИА"');
    expect(fansRev?.sellerInn).toBe('1324002440');
    expect(fansRev?.unitCodes).toHaveLength(6);

    expect(fansFwd?.name).toContain('Transwarp FORWARD');
    expect(fansFwd?.qty).toBe('5');
    expect(fansFwd?.lineTotal).toBe('2950.00');

    expect(psu1?.name).toBe('1stPlayer Блок питания NGDP 850W, 80+Gold, ATX 3.1');
    expect(psu1?.qty).toBe('1');
    expect(psu1?.unitPrice).toBe('7018.00');
    expect(psu1?.sellerName).toBe('ОНЛАЙН ТРЕЙД ООО');

    // Имя продавца этой позиции пришло ПОСЛЕ разрыва страницы (футер вырезан).
    expect(aio?.name).toBe('ID-COOLING СЖО FX360 LCD');
    expect(aio?.unitPrice).toBe('5638.00');
    expect(aio?.sellerName).toBe('ОНЛАЙН ТРЕЙД ООО');

    expect(psu2?.name).toContain('PHANTEKS Блок питания AMP GH');
    expect(psu2?.unitPrice).toBe('7559.00');

    // Один чек содержит позиции из ДВУХ разных WB-заказов (разные хэши кода).
    const hashes = new Set(res.items.map((i) => i.wbOrderHash));
    expect(hashes.size).toBe(2);
    expect(psu2?.wbOrderHash).not.toBe(psu1?.wbOrderHash);

    // Σ позиций == Итого — предупреждений нет.
    expect(res.warnings).toEqual([]);
  });

  it('чек-2: две позиции с разными продавцами, НДС 22%', async () => {
    const res = await parseWbReceiptPdf(loadPrivate('wb-receipt-2.pdf'));

    expect(res.receiptDate?.toISOString()).toBe('2026-04-09T05:21:00.000Z');
    expect(res.checkNumber).toBe('2988');
    expect(res.fpd).toBe('2171153972');
    expect(res.totalAmount).toBe('49151.00');

    expect(res.items).toHaveLength(2);
    const [gpu, cpu] = res.items;
    expect(gpu?.name).toContain('Palit Видеокарта RTX 5060');
    expect(gpu?.unitPrice).toBe('34334.00');
    expect(gpu?.sellerInn).toBe('7733510051');
    expect(gpu?.sellerName).toBe('ООО "ХОЛОДИЛЬНИК.РУ"');
    expect(cpu?.name).toContain('Ryzen 7 7700');
    expect(cpu?.unitPrice).toBe('14817.00');
    expect(cpu?.sellerName).toBe('ООО "СИТИЛИНК"');

    expect(res.warnings).toEqual([]);
  });

  it('чек-3: «Без НДС», иностранные продавцы, продавец после разрыва страницы', async () => {
    const res = await parseWbReceiptPdf(loadPrivate('wb-receipt-3.pdf'));

    expect(res.receiptDate?.toISOString()).toBe('2026-04-06T23:54:00.000Z');
    expect(res.fpd).toBe('1999020322');
    expect(res.totalAmount).toBe('92414.00');

    expect(res.items).toHaveLength(3);
    const [ssd, cpu, gpu] = res.items;
    expect(ssd?.name).toContain('Samsung 990EVO PLUS');
    expect(ssd?.unitPrice).toBe('13160.00');
    // Иностранный продавец: нулевой ИНН + не-кириллическое имя.
    expect(ssd?.sellerInn).toBe('000000000000');
    expect(ssd?.sellerName).toBe('羅斯塔國際貿易有限公司');
    expect(cpu?.name).toContain('Core i5 14600K');
    // Одинаковый нулевой ИНН у разных продавцов — позиции НЕ слиплись.
    expect(cpu?.sellerName).toBe('達焱國際有限公司');
    expect(gpu?.name).toContain('RTX 5070');
    expect(gpu?.unitPrice).toBe('60816.00');
    // Блок «ИНН продавца + имя» этой позиции целиком уехал за разрыв страницы.
    expect(gpu?.sellerInn).toBe('235002776970');
    expect(gpu?.sellerName).toBe('ИП Петренко Ю. И.');

    expect(res.warnings).toEqual([]);
  });
});
