import { z } from 'zod';

/**
 * IJ7: строгая валидация календарной даты. `Date.parse('2026-02-31')` НЕ даёт
 * NaN — JS тихо перекатывает 31 февраля в 3 марта, и невалидная дата проходила
 * в reconciliation/transfer, сажая операцию не в тот месяц. Здесь проверяем, что
 * префикс YYYY-MM-DD — реальный календарный день (компоненты переживают
 * нормализацию через Date.UTC без переката). Время суток (если есть) допускается.
 */
export const isoDate = z.string().refine((s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return false;
  }
  // Полная строка (с временем/зоной, если есть) обязана парситься.
  return !Number.isNaN(Date.parse(s));
}, 'invalid calendar date');
