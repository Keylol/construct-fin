import { PDFParse } from 'pdf-parse';
import { parseAmount, parseDate } from './values';
import type { ParseResult, ParsedRow } from './types';

const TX_LINE_RX =
  /^(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})\s+(\d+)\s+([+-][\d,]+\.\d{2})\s*₽\s+([+-][\d,]+\.\d{2})\s*₽$/;
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
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
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
    const docNo = m[3] ?? '';
    const amountOpRaw = m[4] ?? '';

    const dateLine = lines[i - 1] ?? '';
    if (!DATE_ONLY_RX.test(dateLine)) continue;
    const date = parseDate(dateLine);
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
      raw: { date: dateLine, time, docNo, amount: amountOpRaw, description },
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
