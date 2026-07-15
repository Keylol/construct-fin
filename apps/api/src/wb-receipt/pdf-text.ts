// pdf-parse v1 имеет баг: index.js читает тестовый файл при импорте. Берём
// внутренний модуль напрямую. Единая точка извлечения текста для всех парсеров.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
  buffer: Buffer,
) => Promise<{ text: string; numpages: number }>;

/** Извлекает непустые обрезанные строки текста PDF (без футеров-фильтра). */
export async function extractPdfLines(buffer: Buffer): Promise<string[]> {
  const parsed = await pdfParse(buffer);
  return parsed.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Полный сырой текст PDF — для детекта источника по маркерам. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  return parsed.text;
}
