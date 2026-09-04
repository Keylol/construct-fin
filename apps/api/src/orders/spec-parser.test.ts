import { describe, it, expect } from 'vitest';
import { parseSpecTables, docxTables } from './spec-parser';

/**
 * Живые спецификации лежат вне репозитория (в них ФИО и телефоны клиентов),
 * поэтому тесты работают с таблицами — тем, что остаётся от .docx после
 * распаковки. Формы взяты с пяти реальных файлов за март–июль.
 */

const header = (orderNo: string, client: string, title = 'ПК CONSTRUCTPC (Intel Core i5-12400F)') => [
  ['Детали заказа:', ''],
  ['Заказ №:', orderNo],
  ['Исполнитель:', 'ИП Каменский Илья Юрьевич | ИНН 667302152487'],
  ['Наименование:', title],
  ['Заказчик:', client],
];

const specTable = (rows: string[]) => rows.map((r) => ['', '', r]);

describe('разбор спецификации CONSTRUCTPC', () => {
  it('шапка: телефон, дата, клиент, название', () => {
    const d = parseSpecTables([
      header('+7 922 126 67 02 от 28 июля 2026г.', 'Архипов Константин Сергеевич (С)'),
      specTable(['1 Процессор: Intel Core i5-12400F', 'Итого: 113 343.00 руб.']),
    ]);
    expect(d.phone).toBe('+79221266702');
    expect(d.date?.slice(0, 10)).toBe('2026-07-28');
    // Буква в скобках — пометка магазина, не часть имени.
    expect(d.clientName).toBe('Архипов Константин Сергеевич');
    expect(d.title).toBe('ПК CONSTRUCTPC (Intel Core i5-12400F)');
    expect(d.warnings).toEqual([]);
  });

  it('телефон без плюса и скобок тоже разбирается', () => {
    const d = parseSpecTables([
      header('89655040022 от 24 марта 2026г.', 'Аминев Александр Леонидович (Р)'),
      specTable(['1 Процессор: AMD Ryzen 7 7800X3D', 'Стоимость: 181 467.00 руб.']),
    ]);
    expect(d.phone).toBe('+79655040022');
    expect(d.date?.slice(0, 10)).toBe('2026-03-24');
  });

  it('клиент без пробела перед пометкой', () => {
    const d = parseSpecTables([
      header('89049887994 от 20 апреля 2026г.', 'Богачев Александр Игоревич(Е)'),
      specTable(['1 Процессор: Intel Core i5-14400F', 'Стоимость: 146 000.00 руб.']),
    ]);
    expect(d.clientName).toBe('Богачев Александр Игоревич');
  });

  it('позиции берутся с номерами и без, услуги в них не попадают', () => {
    const d = parseSpecTables([
      header('89111853530 от 10 мая 2026г.', 'Бердин Андрей Валерьевич(Р)'),
      specTable([
        '1 Процессор: AMD Ryzen 7 7800X3D',
        '2 Видеокарта: Palit GeForce RTX 5070 Infinity 3',
        'Вентиляторы: 3 шт. вентиляторов ARGB',
        'Дополнительно: Фирменная гарантия CONSTRUCTPC 12 месяцев',
        'Тестирование: Стандартный стресс-тест 4 часа',
        'Настройка BIOS-Обновление BIOS-настройка вентиляторов',
        'Стоимость: 208 941.00 руб.',
      ]),
    ]);
    expect(d.items.map((i) => i.kind)).toEqual(['Процессор', 'Видеокарта', 'Вентиляторы']);
    expect(d.items[0]?.name).toBe('AMD Ryzen 7 7800X3D');
  });

  it('«Итого» перекрывает частные суммы', () => {
    const d = parseSpecTables([
      header('89000000000 от 1 июня 2026г.', 'Иванов Иван Иванович (С)'),
      specTable(['1 Процессор: Intel Core i5', 'Цена: 107 945.00 руб.']),
      specTable(['Цена: 5 397,00 руб.', 'Итого: 113 343.00 руб.']),
    ]);
    expect(d.total).toBe('113343.00');
  });

  it('без «Итого» суммы сборки и услуг складываются', () => {
    const d = parseSpecTables([
      header('89000000000 от 21 июля 2026г.', 'Асметкина Валентина Андреевна (Р)'),
      specTable(['1 Процессор: Intel Core i5-14400F', 'Цена: 123 526.00 руб.']),
      specTable(['Цена: 6 176.00 руб.']),
    ]);
    expect(d.total).toBe('129702.00');
  });

  it('чужой документ не притворяется спецификацией — говорит, чего не хватает', () => {
    const d = parseSpecTables([[['Договор оказания услуг']]]);
    expect(d.warnings).toContain('В шапке нет строки «Заказ №»');
    expect(d.warnings).toContain('В шапке нет строки «Заказчик»');
    expect(d.warnings).toContain('Не найдено ни одной позиции спецификации');
    expect(d.warnings).toContain('Не найден итог заказа');
  });

  it('текст ячейки собирается из кусков, на которые Word рвёт слова', () => {
    // Word хранит «28 июля» как отдельные <w:t>: «2», «8», «ию», «л», «я».
    const xml =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Заказ №:</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>+7 922 126 67 02 </w:t><w:t>от</w:t><w:t xml:space="preserve"> 2</w:t>' +
      '<w:t>8</w:t><w:t> ию</w:t><w:t>л</w:t><w:t>я</w:t><w:t> 2026</w:t><w:t>г.</w:t>' +
      '</w:r></w:p></w:tc></w:tr></w:tbl>';
    const tables = docxTables(xml);
    expect(tables[0]?.[0]?.[1]).toBe('+7 922 126 67 02 от 28 июля 2026г.');
  });
});
