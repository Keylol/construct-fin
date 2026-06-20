/**
 * Money helpers. ВАЖНО: используем строки для денег в DTO,
 * чтобы не терять точность при JSON-сериализации Decimal.
 */

/**
 * Форматирует число/строку в "1 234 567,89 ₽" (RU). Отрицательные — в
 * бухгалтерских скобках: "(128 400,00 ₽)". (Локаль ru-RU в режиме
 * currencySign:'accounting' рисует минус, а не скобки, поэтому оборачиваем сами.)
 */
export function formatRub(value: string | number, decimals = 2): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  const abs = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(num));
  return num < 0 ? `(${abs})` : abs;
}

/** Парсит "1 234,50" / "1234.5" → строка "1234.50" для отправки в API. */
export function parseAmountInput(input: string): string | null {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}
