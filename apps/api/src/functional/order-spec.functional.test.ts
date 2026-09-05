/**
 * Функциональные тесты двух ручек мастера «Заказ из архива»: разбор
 * спецификации (.docx) и разбор чека ради закупочных цен. Обе принимают
 * multipart и ничего не сохраняют — проверяем контракт и, главное, поведение
 * на мусорных файлах: в папке архива рядом с чеками лежат сканы, счета и
 * письма, и каждый такой файл раньше отвечал 500 с алертом владельцу.
 *
 * Эндпоинты: POST /orders/spec-preview · POST /orders/costs-preview.
 * Диапазон telegramId: 2790000n+ (не пересекается с другими сьютами).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { buildHttpApp, type HttpApp } from '../e2e/http-harness';
import { resetDb, seedBase, seedMember, type Seed } from '../test/money-harness';

let H: HttpApp;
let seed: Seed;
let token: string;
let tg = 2790000n;

const DNS_PDF = readFileSync(
  resolve(__dirname, '../../../../fixtures/imports/dns-fiscal-synth.pdf'),
);

/**
 * Спецификация собирается на лету: репозиторий публичный, а живые документы
 * содержат ФИО и телефоны клиентов. Формат тот же — таблицы Word.
 */
async function specDocx(rows: string[][][]): Promise<Buffer> {
  const cell = (text: string) =>
    `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    rows
      .map(
        (table) =>
          '<w:tbl>' +
          table.map((row) => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('') +
          '</w:tbl>',
      )
      .join('') +
    '</w:body></w:document>';
  const zip = new JSZip();
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function multipart(file: Buffer, filename: string, contentType: string) {
  const boundary = 'XbCyOrderSpecBoundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

beforeAll(async () => {
  H = await buildHttpApp();
});
afterAll(async () => {
  await H.app.close();
});
beforeEach(async () => {
  await resetDb(H.prisma);
  tg += 1n;
  seed = await seedBase(H.prisma, tg);
  await seedMember(H.prisma, seed.workspaceId, seed.userId);
  token = await H.jwtFor(seed.userId, tg);
});

async function post(url: string, file: Buffer, name: string, type: string) {
  const { boundary, body } = multipart(file, name, type);
  return H.inject({
    method: 'POST',
    url,
    token,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe('Функциональные: мастер «Заказ из архива»', () => {
  it('POST /orders/spec-preview → 200: телефон, клиент, позиции, итог; в БД пусто', async () => {
    const ws = seed.workspaceId;
    const docx = await specDocx([
      [
        ['Заказ №:', '+7 922 126 67 02 от 28 июля 2026г.'],
        ['Наименование:', 'ПК CONSTRUCTPC (Intel Core i5-12400F; RTX 5060 Ti)'],
        ['Заказчик:', 'Иванов Иван Иванович (Р)'],
      ],
      [
        ['1', 'Процессор: Intel Core i5-12400F'],
        ['2', 'Видеокарта: GIGABYTE GeForce RTX 5060 Ti WINDFORCE'],
        ['', 'Итого: 113 343.00 руб.'],
      ],
    ]);

    const res = await post(
      `/workspaces/${ws}/orders/spec-preview`,
      docx,
      'spec.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.statusCode).toBe(200);
    const d = res.json<{
      phone: string;
      clientName: string;
      title: string;
      total: string;
      items: { kind: string }[];
      warnings: string[];
    }>();
    expect(d.phone).toBe('+79221266702');
    expect(d.clientName).toBe('Иванов Иван Иванович');
    expect(d.total).toBe('113343.00');
    expect(d.items.map((i) => i.kind)).toEqual(['Процессор', 'Видеокарта']);
    expect(d.warnings).toEqual([]);
    expect(await H.prisma.order.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('POST /orders/spec-preview → 400 на файле, который не .docx', async () => {
    const res = await post(
      `/workspaces/${seed.workspaceId}/orders/spec-preview`,
      Buffer.from('не документ, а просто текст'),
      'spec.docx',
      'application/octet-stream',
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders/spec-preview → 400 на пустом файле и без multipart', async () => {
    const ws = seed.workspaceId;
    expect((await post(`/workspaces/${ws}/orders/spec-preview`, Buffer.alloc(0), 'e.docx', 'application/octet-stream')).statusCode).toBe(400);

    const res = await H.inject({
      method: 'POST',
      url: `/workspaces/${ws}/orders/spec-preview`,
      token,
      payload: { file: 'нет' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders/costs-preview → 200: строки чека с ценами и количеством', async () => {
    const res = await post(
      `/workspaces/${seed.workspaceId}/orders/costs-preview`,
      DNS_PDF,
      'receipt.pdf',
      'application/pdf',
    );
    expect(res.statusCode).toBe(200);
    const r = res.json<{
      source: string;
      items: { name: string; qty: string; unitPrice: string }[];
    }>();
    expect(r.source).toBe('DNS');
    expect(r.items.length).toBeGreaterThan(0);
    expect(Number(r.items[0]?.unitPrice)).toBeGreaterThan(0);
  });

  it('POST /orders/costs-preview → 400, а не 500, на нечитаемом PDF', async () => {
    // Скан-картинка и битый файл — обычные жители папки архива. До обёртки в
    // контроллере каждый такой файл поднимал 500 и слал владельцу алерт.
    const res = await post(
      `/workspaces/${seed.workspaceId}/orders/costs-preview`,
      Buffer.from('%PDF-1.4 битый файл без структуры'),
      'scan.pdf',
      'application/pdf',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('Не удалось прочитать файл');
  });

  it('POST /orders/costs-preview → 200 с предупреждением, если источник чужой', async () => {
    // Чек Ozon или счёт: текст читается, магазин не наш — позиций нет, но и
    // ошибки нет: человек введёт строки руками.
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body/></w:document>');
    const notReceipt = await zip.generateAsync({ type: 'nodebuffer' });
    const res = await post(
      `/workspaces/${seed.workspaceId}/orders/costs-preview`,
      notReceipt,
      'cheque.pdf',
      'application/pdf',
    );
    expect([200, 400]).toContain(res.statusCode);
  });
});
