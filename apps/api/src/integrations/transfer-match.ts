import { D } from '../common/money';

/**
 * Поиск переводов между своими счетами среди строк выписки.
 *
 * Перевод приезжает из банка ДВУМЯ независимыми строками: расход на счёте-
 * источнике и приход на счёте-получателе. Разобранные по отдельности, они
 * задваивают обороты — деньги выглядят как настоящий расход и настоящий доход,
 * хотя из бизнеса не выходили. С двумя подключёнными банками это происходит с
 * каждым переводом между ними.
 *
 * Автоматически ничего не проводим: ложная склейка спрячет реальный доход или
 * расход, а это хуже, чем лишний клик. Функция лишь предлагает пары — решение
 * за человеком. Ни в одном из изученных аналогов (Actual, Firefly, ERPNext,
 * Medusa) автодетект тоже не сделан, везде подтверждение вручную.
 */

/** Окно между ногами: банки проводят стороны перевода не одномоментно. */
export const TRANSFER_WINDOW_DAYS = 3;
/** Комиссия сверх суммы: доля от перевода и абсолютный потолок. */
const FEE_MAX_SHARE = 0.01;
const FEE_MAX_ABS = 5000;

export interface MatchLine {
  id: string;
  accountId: string;
  date: Date;
  /** Модуль суммы десятичной строкой. */
  amount: string;
  direction: 'INCOME' | 'EXPENSE';
}

export interface TransferPair<T extends MatchLine = MatchLine> {
  out: T;
  in: T;
  /** Разница сумм, объяснимая комиссией банка (десятичная строка). */
  fee: string;
  /** exact — суммы совпали до копейки; with_fee — расход больше на комиссию. */
  confidence: 'exact' | 'with_fee';
}

/**
 * Комиссия правдоподобна, если расход больше прихода на небольшую величину:
 * до 1% суммы и не больше 5000 ₽. Всё, что крупнее, — это не комиссия, а две
 * разные операции, случайно оказавшиеся рядом.
 */
function feeIfPlausible(outAmount: string, inAmount: string): string | null {
  const out = D(outAmount);
  const inc = D(inAmount);
  if (out.equals(inc)) return '0';
  if (out.lessThan(inc)) return null; // пришло больше, чем ушло — не перевод
  const diff = out.minus(inc);
  if (diff.greaterThan(D(FEE_MAX_ABS))) return null;
  if (diff.greaterThan(out.times(FEE_MAX_SHARE))) return null;
  return diff.toFixed(2);
}

function daysApart(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Подобрать пары «расход ↔ приход» среди строк на разборе.
 *
 * Жадно, от самых достоверных к сомнительным: сначала точные совпадения сумм,
 * затем совпадения с комиссией; внутри — по близости дат. Каждая строка входит
 * не более чем в одну пару, поэтому при нескольких одинаковых суммах пары
 * получатся один-к-одному, а не «все со всеми».
 */
export function matchTransferPairs<T extends MatchLine>(
  lines: T[],
  windowDays: number = TRANSFER_WINDOW_DAYS,
): TransferPair<T>[] {
  const outs = lines.filter((l) => l.direction === 'EXPENSE');
  const ins = lines.filter((l) => l.direction === 'INCOME');

  const candidates: (TransferPair<T> & { gap: number })[] = [];
  for (const out of outs) {
    for (const inc of ins) {
      // Перевод — это движение МЕЖДУ счетами: внутри одного счёта его нет.
      if (out.accountId === inc.accountId) continue;
      const gap = daysApart(out.date, inc.date);
      if (gap > windowDays) continue;
      const fee = feeIfPlausible(out.amount, inc.amount);
      if (fee === null) continue;
      candidates.push({
        out,
        in: inc,
        fee,
        confidence: fee === '0' ? 'exact' : 'with_fee',
        gap,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      // Точное совпадение сумм достовернее совпадения с комиссией...
      Number(a.confidence === 'with_fee') - Number(b.confidence === 'with_fee') ||
      // ...а среди равных — то, что ближе по датам.
      a.gap - b.gap ||
      // Детерминизм между запусками: порядок выборки из БД не должен влиять.
      a.out.id.localeCompare(b.out.id),
  );

  const used = new Set<string>();
  const pairs: TransferPair<T>[] = [];
  for (const c of candidates) {
    if (used.has(c.out.id) || used.has(c.in.id)) continue;
    used.add(c.out.id);
    used.add(c.in.id);
    pairs.push({ out: c.out, in: c.in, fee: c.fee, confidence: c.confidence });
  }
  return pairs;
}
