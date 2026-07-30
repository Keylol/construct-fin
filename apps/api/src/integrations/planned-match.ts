import { D } from '../common/money';

/**
 * Сопоставление строк выписки с ожидаемыми (плановыми) платежами.
 *
 * Без него оплата, на которую заведён план, задваивается: строка из банка
 * становится обычной проводкой, а сам план продолжает висеть «ожидается» — и
 * его закрывают руками второй проводкой. Первый же синк месяца аренды даёт
 * ровно этот сценарий.
 *
 * Автоматически план не гасим: ошибочная привязка пометит оплаченным ЧУЖОЙ
 * план, и настоящий платёж будет пропущен молча. Функция только предлагает,
 * решает человек (паттерн Bills из Firefly III).
 */

/**
 * Окно вокруг срока плана. Платят и заранее, и с опозданием; у месячной
 * регулярки соседние экземпляры отстоят на ~30 дней, так что ±10 не даёт
 * зацепить чужой месяц.
 */
export const PLANNED_WINDOW_DAYS = 10;

export interface PlannedMatchLine {
  id: string;
  date: Date;
  /** Модуль суммы десятичной строкой. */
  amount: string;
  /** ИНН контрагента из выписки, если банк его отдал. */
  counterpartyInn?: string | null;
}

export interface PlannedMatchPlan {
  id: string;
  dueDate: Date;
  amount: string;
  /** ИНН контрагента плана (из справочника), если известен. */
  counterpartyInn?: string | null;
}

export interface PlannedSuggestion<
  L extends PlannedMatchLine = PlannedMatchLine,
  P extends PlannedMatchPlan = PlannedMatchPlan,
> {
  line: L;
  plan: P;
}

function digits(raw?: string | null): string {
  return (raw ?? '').replace(/\D/g, '');
}

function daysApart(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Подобрать пары «строка ↔ план»: сумма совпадает до копейки, дата строки в
 * окне вокруг срока. Несовпадение ИНН, когда он известен у обеих сторон,
 * исключает пару; совпадение — поднимает в приоритете. Жадно, один к одному,
 * ближе к сроку — раньше.
 *
 * Суммы сравниваются только точно: план на 30 000 не должен цепляться за
 * похожие 29 900. Допуск («вилка» суммы у плана, как в Firefly) — осознанно
 * отложен до реальной нужды.
 */
export function matchPlannedPayments<L extends PlannedMatchLine, P extends PlannedMatchPlan>(
  lines: L[],
  plans: P[],
  windowDays: number = PLANNED_WINDOW_DAYS,
): PlannedSuggestion<L, P>[] {
  const candidates: (PlannedSuggestion<L, P> & { gap: number; innMatch: boolean })[] = [];
  for (const line of lines) {
    for (const plan of plans) {
      if (!D(line.amount).equals(D(plan.amount))) continue;
      const gap = daysApart(line.date, plan.dueDate);
      if (gap > windowDays) continue;
      const lineInn = digits(line.counterpartyInn);
      const planInn = digits(plan.counterpartyInn);
      if (lineInn && planInn && lineInn !== planInn) continue;
      candidates.push({ line, plan, gap, innMatch: !!lineInn && lineInn === planInn });
    }
  }

  candidates.sort(
    (a, b) =>
      // Подтверждение контрагента достовернее простого совпадения суммы...
      Number(b.innMatch) - Number(a.innMatch) ||
      // ...среди равных — ближе к сроку.
      a.gap - b.gap ||
      // Детерминизм между запусками.
      a.line.id.localeCompare(b.line.id) ||
      a.plan.id.localeCompare(b.plan.id),
  );

  const usedLines = new Set<string>();
  const usedPlans = new Set<string>();
  const out: PlannedSuggestion<L, P>[] = [];
  for (const c of candidates) {
    if (usedLines.has(c.line.id) || usedPlans.has(c.plan.id)) continue;
    usedLines.add(c.line.id);
    usedPlans.add(c.plan.id);
    out.push({ line: c.line, plan: c.plan });
  }
  return out;
}
