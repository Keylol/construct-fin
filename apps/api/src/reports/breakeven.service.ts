import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PnlService } from './pnl.service';
import type { Period } from './period';

/**
 * Точка безубыточности (break-even) за период — тонкая обёртка над ОПиУ:
 * та же методология признания (IJ9), те же бакеты.
 *
 *  Выручка R        = REVENUE.income − REVENUE.expense (чистая, минус возвраты)
 *  Переменные V     = (COGS.expense − COGS.income) + (VARIABLE.expense − VARIABLE.income)
 *  Постоянные F     = FIXED.expense − FIXED.income (зарплата входит: SALARY → FIXED)
 *  Маржинальность   = (R − V) / R
 *  Точка BEP        = F / маржинальность (выручка, при которой прибыль = 0)
 *  Запас прочности  = (R − BEP) / R × 100 %
 *
 * Налоги (TAX) в формулу не входят: АУСН зависит от прибыли и не является ни
 * постоянной, ни переменной статьёй. CAPITAL/OTHER/PURCHASES — вне операционки.
 */

export interface BreakevenReport {
  period: { from: string; to: string };
  revenue: string;
  variableCosts: { cogs: string; variable: string; total: string };
  fixedCosts: string;
  /** Маржинальный доход R − V. */
  contributionMargin: string;
  /** Доля маржинального дохода в выручке, % (null — выручки нет). */
  contributionMarginPct: number | null;
  /** Выручка точки безубыточности (null — не определена: нет выручки или V ≥ R). */
  breakevenRevenue: string | null;
  /** (R − BEP)/R × 100; отрицательный — до точки ещё не дотянули. */
  safetyMarginPct: number | null;
  /** R / BEP × 100 — сколько процентов точки пройдено. */
  achievedPct: number | null;
}

const D0 = new Prisma.Decimal(0);

@Injectable()
export class BreakevenService {
  constructor(private readonly pnl: PnlService) {}

  async build(workspaceId: string, period: Period): Promise<BreakevenReport> {
    const pnl = await this.pnl.build({
      workspaceId,
      primary: period,
      comparison: null,
      groupBy: 'month',
    });

    const net = new Map<string, Prisma.Decimal>();
    for (const b of pnl.primary.totals.byBucket) {
      net.set(b.bucket, new Prisma.Decimal(b.expense).minus(b.income));
    }
    // Для REVENUE знак обратный: доходный бакет (income − expense).
    const revenue = (net.get('REVENUE') ?? D0).negated();
    const cogs = net.get('COGS') ?? D0;
    const variable = net.get('VARIABLE') ?? D0;
    const fixed = net.get('FIXED') ?? D0;

    const variableTotal = cogs.plus(variable);
    const contribution = revenue.minus(variableTotal);

    let cmrPct: number | null = null;
    let breakeven: Prisma.Decimal | null = null;
    if (revenue.greaterThan(0)) {
      const cmr = contribution.div(revenue);
      cmrPct = Number(cmr.times(100).toFixed(1));
      if (cmr.greaterThan(0)) {
        breakeven = fixed.div(cmr);
      }
    }

    const safetyPct =
      breakeven && revenue.greaterThan(0)
        ? Number(revenue.minus(breakeven).div(revenue).times(100).toFixed(1))
        : null;
    const achievedPct =
      breakeven && breakeven.greaterThan(0)
        ? Number(revenue.div(breakeven).times(100).toFixed(1))
        : null;

    return {
      period: pnl.primary.period,
      revenue: revenue.toFixed(2),
      variableCosts: {
        cogs: cogs.toFixed(2),
        variable: variable.toFixed(2),
        total: variableTotal.toFixed(2),
      },
      fixedCosts: fixed.toFixed(2),
      contributionMargin: contribution.toFixed(2),
      contributionMarginPct: cmrPct,
      breakevenRevenue: breakeven ? breakeven.toFixed(2) : null,
      safetyMarginPct: safetyPct,
      achievedPct,
    };
  }
}
