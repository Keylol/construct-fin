/**
 * Money helpers. ВАЖНО: используем строки для денег в DTO,
 * чтобы не терять точность при JSON-сериализации Decimal.
 */

/** Форматирует копейки/число/строку в "1 234 567,89 ₽" (RU). */
export function formatRub(value: string | number, decimals = 2): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

/** Парсит "1 234,50" / "1234.5" → строка "1234.50" для отправки в API. */
export function parseAmountInput(input: string): string | null {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}
