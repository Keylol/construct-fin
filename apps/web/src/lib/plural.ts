/**
 * Русское склонение существительного при числительном: «1 операция»,
 * «2 операции», «5 операций». Канцелярские скобки вида «5 выплат(ы)» в видимых
 * текстах запрещены — аудит 2026-07-31 нашёл их в трёх местах.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const d10 = abs % 10;
  const d100 = abs % 100;
  if (d100 >= 11 && d100 <= 14) return many;
  if (d10 === 1) return one;
  if (d10 >= 2 && d10 <= 4) return few;
  return many;
}
