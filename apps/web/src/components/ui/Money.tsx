import { formatRub } from '@construct/shared';
import { cn } from '@/lib/cn';

/**
 * Денежная величина — одно место, где живут все правила показа рубля:
 * моноширинный tabular (цифры в колонке стоят строго друг под другом),
 * бухгалтерские скобки для минуса и красный цвет к ним.
 *
 * До этого каждая сумма собиралась руками — `formatRub` плюс класс `num` плюс
 * иногда цвет, — и правило про красный минус держалось на памяти: в балансе
 * счёт «(6,00 ₽)» был серым наравне с обычными строками.
 *
 * Цвет:
 *   tone="auto"  — по умолчанию: минус красным, остальное наследует цвет;
 *   tone="plain" — цвет не трогаем (когда он уже несёт смысл: доход зелёным,
 *                  приглушённая справочная сумма, инверсия на тёмной плашке).
 */
export function Money({
  value,
  decimals = 2,
  tone = 'auto',
  className,
}: {
  value: string | number;
  decimals?: number;
  tone?: 'auto' | 'plain';
  className?: string;
}) {
  const negative = Number(value) < 0;
  return (
    <span className={cn('num', className, tone === 'auto' && negative && 'text-destructive')}>
      {formatRub(value, decimals)}
    </span>
  );
}
