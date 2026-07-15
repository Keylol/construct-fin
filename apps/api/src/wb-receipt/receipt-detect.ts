import { extractPdfLines } from './pdf-text';
import { parseWbReceiptPdf } from './receipt-parser';
import { parseDnsLines } from './dns-parser';
import { parseOnlineTradeLines } from './onlinetrade-parser';
import type { ParsedReceipt } from './receipt-types';

const WB_MARKER = /receipt\.wb\.ru|wildberries/i;
const DNS_MARKER = /ДНС Ритейл|dns-shop\.ru/i;
const OT_MARKER = /онлайн\s*трейд|onlinetrade\.ru/i;

/** Приводит WB-разбор к общей форме ParsedReceipt (ФПД → docNumber, хэш → sourceRef). */
async function parseWbAsReceipt(buffer: Buffer): Promise<ParsedReceipt> {
  const wb = await parseWbReceiptPdf(buffer);
  return {
    source: 'WB_CARD',
    receiptDate: wb.receiptDate,
    docNumber: wb.fpd,
    checkNumber: wb.checkNumber,
    fd: wb.fd,
    totalAmount: wb.totalAmount,
    items: wb.items.map((it) => ({
      name: it.name,
      qty: it.qty,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
      sellerName: it.sellerName,
      sellerInn: it.sellerInn,
      sourceRef: it.wbOrderHash,
    })),
    warnings: wb.warnings,
  };
}

/**
 * Определяет источник PDF по маркерам и разбирает соответствующим парсером.
 * Возвращает нормализованный ParsedReceipt. Если источник не распознан —
 * ParsedReceipt с warning (оператор введёт/поправит вручную в мастере).
 */
export async function detectAndParseReceipt(buffer: Buffer): Promise<ParsedReceipt> {
  const lines = await extractPdfLines(buffer);
  const text = lines.join('\n');

  if (WB_MARKER.test(text)) return parseWbAsReceipt(buffer);
  if (DNS_MARKER.test(text)) return parseDnsLines(lines);
  if (OT_MARKER.test(text)) return parseOnlineTradeLines(lines);

  // Источник не распознан → трактуем как ручной ввод (без дедупа, docNumber=null):
  // WB_CARD с пустым ключом дал бы ложную метку и отказ superRefine на commit.
  return {
    source: 'MANUAL',
    receiptDate: null,
    docNumber: null,
    checkNumber: null,
    fd: null,
    totalAmount: null,
    items: [],
    warnings: [
      'Не удалось определить источник документа (WB / ДНС / Онлайн Трейд). ' +
        'Введите позиции вручную.',
    ],
  };
}
