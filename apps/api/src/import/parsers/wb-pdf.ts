// pdf-parse v1 имеет баг: index.js пытается читать тестовый файл при импорте.
// Импортируем внутренний модуль напрямую.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
  buffer: Buffer,
) => Promise<{ text: string; numpages: number }>;
import { parseAmount, parseDate } from './values';
import type { ParseResult, ParsedRow } from './types';

// v1 squishes: "DD.MM.YYYY<docNo><±amount>.XX ₽<±amount>.XX ₽"
// v2 spaces: "HH:MM DD.MM.YYYY <docNo> <±amount>.XX ₽ <±amount>.XX ₽"
// Покрываем оба варианта.
const TX_LINE_RX =
  /(?:^|\s)(?:(\d{2}:\d{2})\s+)?(\d{2}\.\d{2}\.\d{4})\s*(\d+)\s*([+-][\d,]+\.\d{2})\s*₽\s*([+-][\d,]+\.\d{2})\s*₽\s*$/;
const DATE_ONLY_RX = /^\d{2}\.\d{2}\.\d{4}$/;
const CARD_TERMINATOR_RX = /^-$/;

function extractCounterparty(description: string): string | null {
  const recipient = /Получатель:\s*([^)]+?)(?:\)|$)/i.exec(description);
  if (recipient) return recipient[1]?.trim() ?? null;
  const sender = /Отправитель:\s*([^,]+)/i.exec(description);
  if (sender) return sender[1]?.trim() ?? null;
  return null;
}

export async function parseWbPdf(buffer: Buffer): Promise<ParseResult> {
  const result = await pdfParse(buffer);
  const lines = result.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: ParsedRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = TX_LINE_RX.exec(line);
    if (!m) continue;

    const time = m[1] ?? '';
    const dateInLine = m[2] ?? '';
    const docNo = m[3] ?? '';
    const amountOpRaw = m[4] ?? '';

    const date = parseDate(dateInLine);
    if (!date) continue;

    const descLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln === undefined) break;
      if (CARD_TERMINATOR_RX.test(ln)) break;
      if (DATE_ONLY_RX.test(ln)) break;
      if (TX_LINE_RX.test(ln)) break;
      descLines.push(ln);
    }
    const description = descLines.join(' ').trim();

    const sign = amountOpRaw.startsWith('-') ? '-' : '';
    const amountSigned = parseAmount(sign + amountOpRaw.replace(/^[+-]/, ''));
    if (!amountSigned) continue;

    const type: 'INCOME' | 'EXPENSE' = amountSigned.startsWith('-') ? 'EXPENSE' : 'INCOME';
    const amount = amountSigned.replace(/^-/, '');
    const counterpartyName = extractCounterparty(description);

    rows.push({
      rawIndex: rows.length + 1,
      date,
      amount,
      type,
      description: description || null,
      counterpartyName,
      raw: { date: dateInLine, time, docNo, amount: amountOpRaw, description },
      errors: [],
    });
  }

  return {
    headers: ['Дата', 'Время', 'Номер документа', 'Сумма', 'Описание операции'],
    rows,
    suggestedMapping: {
      date: 'Дата',
      amount: 'Сумма',
      description: 'Описание операции',
      counterparty: 'Получатель/Отправитель',
    },
    encoding: 'utf-8',
    source: 'WB_PDF',
  };
}
