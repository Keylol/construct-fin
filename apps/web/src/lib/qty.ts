/** Нормализует ввод количества → строка с ≤3 знаками после точки или null. */
export function parseQty(input: string): string | null {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) return null;
  return cleaned;
}
