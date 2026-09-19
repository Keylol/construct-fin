import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectAndParseReceipt } from './receipt-detect';
import { parseOnlineTradeLines } from './onlinetrade-parser';

const FIXTURES = resolve(__dirname, '../../../../fixtures/imports');
const PRIVATE = resolve(FIXTURES, 'private');
const has = (n: string) => existsSync(resolve(PRIVATE, n));
const load = (n: string) => readFileSync(resolve(PRIVATE, n));
const loadFix = (n: string) => readFileSync(resolve(FIXTURES, n));

describe('Мультиисточник (синтетика, всегда в CI)', () => {
  it('ДНС кассовый чек: имя, цена, код, ФП-ключ', async () => {
    const r = await detectAndParseReceipt(loadFix('dns-fiscal-synth.pdf'));
    expect(r.source).toBe('DNS');
    expect(r.checkNumber).toBe('1060');
    expect(r.receiptDate?.toISOString().slice(0, 10)).toBe('2026-02-20');
    expect(r.fd).toBe('24744');
    expect(r.docNumber).toBe('1540765152');
    expect(r.totalAmount).toBe('21599.00');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.name).toContain('B850');
    expect(r.items[0]?.qty).toBe('1');
    expect(r.items[0]?.lineTotal).toBe('21599.00');
    expect(r.items[0]?.sourceRef).toBe('5653309');
    expect(r.warnings).toEqual([]);
  });

  it('ДНС товарный заказ: 2 позиции, развязка 4 склеенных полей, кол-во 3', async () => {
    const r = await detectAndParseReceipt(loadFix('dns-order-synth.pdf'));
    expect(r.source).toBe('DNS');
    expect(r.docNumber).toBe('6Б-010566220');
    expect(r.totalAmount).toBe('53999.00');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.qty).toBe('1');
    expect(r.items[0]?.lineTotal).toBe('38999.00');
    // Вторая позиция: 5000 × 3 = 15000 (кол-во из инварианта, не «30»).
    expect(r.items[1]?.qty).toBe('3');
    expect(r.items[1]?.unitPrice).toBe('5000');
    expect(r.items[1]?.lineTotal).toBe('15000.00');
    expect(r.warnings).toEqual([]);
  });

  it('ОНЛАЙН ТРЕЙД: 4 строки, кол-во 5 из инварианта, имена из секции', async () => {
    const r = await detectAndParseReceipt(loadFix('onlinetrade-synth.pdf'));
    expect(r.source).toBe('ONLINE_TRADE');
    expect(r.docNumber).toBe('44592569');
    expect(r.totalAmount).toBe('30502.00');
    expect(r.items).toHaveLength(4);
    expect(r.items[0]?.qty).toBe('1');
    expect(r.items[0]?.unitPrice).toBe('22399');
    expect(r.items[2]?.qty).toBe('5');
    expect(r.items[2]?.lineTotal).toBe('2895.00');
    expect(r.warnings).toEqual([]);
  });

  it('нераспознанный PDF (WB-выписка) → warning без позиций', async () => {
    // Выписка ВБ Банка содержит «wildberries» → WB-парсер, но это не чек.
    const r = await detectAndParseReceipt(loadFix('wb-statement-synth.pdf'));
    expect(r.items).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('ОНЛАЙН ТРЕЙД: имя-аббревиатура не выпадает из секции названий', () => {
  // Регресс на находку с реальным заказом Шмакова: «СВО для процессора DeepCool
  // LE360 PRO» — аббревиатура заглавными как первое слово. Признак начала имени
  // требовал [заглавная][строчная], такая строка ему не отвечала: при пустом
  // nameBuf она молча выбрасывалась (см. `continue` по !looksLikeStart), и
  // следующее реальное имя занимало её место — цена «Блока питания» уезжала на
  // позицию кулера, а последняя позиция заказа оставалась без имени вовсе
  // («Позиция 3»). Юнит вместо PDF-фикстуры: parseOnlineTradeLines принимает
  // lines напрямую, минимальный набор строк воспроизводит баг без файла.
  it('название, начинающееся с аббревиатуры заглавными, попадает на свою позицию', () => {
    const r = parseOnlineTradeLines([
      'Заказ No90000001 от 01.09.2026',
      'Код Товар Кол-во Цена Сумма ON-бонусов',
      '19431311 шт.22 399 ₽22 399 ₽434',
      '20000021 шт.6 049 ₽6 049 ₽100',
      '30000031 шт.5 599 ₽5 599 ₽50',
      'Статус заказа',
      'Передан на сборку',
      'схема проезда',
      'Материнская плата ASUS ROG STRIX (B850-A)',
      'СВО для процессора DeepCool LE360 PRO',
      '(LE360PRO-BKAMMC)',
      'Блок питания PHANTEKS Revolt X (P3-1000W)',
      '34 047 ₽Итого:',
      'onlinetrade.ru',
    ]);
    expect(r.items).toHaveLength(3);
    expect(r.items[0]?.name).toBe('Материнская плата ASUS ROG STRIX (B850-A)');
    // Была бы «Блок питания…» (имя следующей позиции) без фикса.
    expect(r.items[1]?.name).toBe('СВО для процессора DeepCool LE360 PRO (LE360PRO-BKAMMC)');
    expect(r.items[1]?.unitPrice).toBe('6049');
    // Была бы «Позиция 3» без фикса — счётчик имён отставал от строк на одну.
    expect(r.items[2]?.name).toBe('Блок питания PHANTEKS Revolt X (P3-1000W)');
    expect(r.warnings).toEqual([]);
  });
});

describe.skipIf(!has('dns-fiscal-1.pdf'))('ДНС кассовый чек (реальный, локально)', () => {
  it('одна позиция: имя, цена, код товара, ФП как ключ', async () => {
    const r = await detectAndParseReceipt(load('dns-fiscal-1.pdf'));
    expect(r.source).toBe('DNS');
    expect(r.checkNumber).toBe('1060');
    expect(r.receiptDate?.toISOString().slice(0, 10)).toBe('2026-02-20');
    expect(r.fd).toBe('24744');
    expect(r.docNumber).toBe('1540765152'); // ФП
    expect(r.totalAmount).toBe('21599.00');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.name).toContain('MSI');
    expect(r.items[0]?.name).toContain('B850');
    expect(r.items[0]?.qty).toBe('1');
    expect(r.items[0]?.unitPrice).toBe('21599');
    expect(r.items[0]?.lineTotal).toBe('21599.00');
    expect(r.items[0]?.sellerInn).toBe('2540167061');
    expect(r.items[0]?.sourceRef).toBe('5653309');
    expect(r.warnings).toEqual([]);
  });
});

describe.skipIf(!has('dns-order-1.pdf'))('ДНС товарный заказ (реальный, локально)', () => {
  it('заказ 6Б-…: развязка 4 склеенных полей, номер заказа как ключ', async () => {
    const r = await detectAndParseReceipt(load('dns-order-1.pdf'));
    expect(r.source).toBe('DNS');
    expect(r.docNumber).toBe('6Б-010566220');
    expect(r.receiptDate?.toISOString().slice(0, 10)).toBe('2026-05-10');
    expect(r.totalAmount).toBe('38999.00');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.name).toContain('ADATA LANCER');
    expect(r.items[0]?.qty).toBe('1');
    expect(r.items[0]?.unitPrice).toBe('38999');
    expect(r.items[0]?.lineTotal).toBe('38999.00');
    expect(r.warnings).toEqual([]);
  });
});

describe.skipIf(!has('onlinetrade-1.pdf'))('ОНЛАЙН ТРЕЙД (реальный, локально)', () => {
  it('4 строки + имена из отдельной секции, кол-во из инварианта', async () => {
    const r = await detectAndParseReceipt(load('onlinetrade-1.pdf'));
    expect(r.source).toBe('ONLINE_TRADE');
    expect(r.docNumber).toBe('44592569');
    expect(r.receiptDate?.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(r.totalAmount).toBe('30502.00');
    expect(r.items).toHaveLength(4);

    // Строка 3 — кол-во 5 (2 895 / 579), развязка код↔кол-во по инварианту.
    const ram = r.items[0];
    expect(ram?.name).toContain('G.Skill');
    expect(ram?.qty).toBe('1');
    expect(ram?.unitPrice).toBe('22399');
    const fanRev = r.items[2];
    expect(fanRev?.qty).toBe('5');
    expect(fanRev?.unitPrice).toBe('579');
    expect(fanRev?.lineTotal).toBe('2895.00');
    // Итог сходится → расхождений нет (наименований столько же, сколько строк).
    expect(r.warnings).toEqual([]);
  });
});
