import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceService } from '../reports/balance.service';
import { PlanningService } from './planning.service';
import { scheduleView } from '../orders/payment-schedule';
import { businessDayParts, businessInstant, startOfDay } from '../reports/period';

/**
 * Прогноз остатка денежных средств на горизонте платёжного календаря —
 * предупреждение кассового разрыва ДО его наступления.
 *
 *  Старт     — текущий суммарный остаток активных счетов (формула баланса).
 *  Оттоки    — ожидаемые плановые платежи (PLANNED) на горизонте; просроченные
 *              ложатся на «сегодня» (их придётся платить сразу).
 *  Притоки   — будущие непокрытые строки графиков платежей ОТКРЫТЫХ заказов
 *              (FIFO-покрытие из paidAmount, scheduleView). Просроченные
 *              ожидания клиентов в прогноз НЕ входят (на них нельзя опираться) —
 *              отдаются отдельной цифрой overdueExpectedIn.
 *
 * Две траектории:
 *  balanceOut — пессимистичная: только оттоки (притоков нет);
 *  balance    — ожидаемая: оттоки + притоки по графикам.
 * Первый день с минусом каждой траектории — firstGap*.
 */

export interface ForecastPoint {
  date: string; // ISO бизнес-дня (полдень UTC+5)
  out: string; // оттоки этого дня
  in: string; // притоки этого дня
  /** Остаток к концу дня: только оттоки (пессимистичная траектория). */
  balanceOut: string;
  /** Остаток к концу дня: оттоки + ожидаемые притоки. */
  balance: string;
}

export interface ForecastReport {
  horizonDays: number;
  asOf: string;
  opening: string;
  points: ForecastPoint[];
  totals: { out: string; in: string };
  /** Просроченные ожидания от клиентов (в траекторию не входят). */
  overdueExpectedIn: string;
  /** Первый день ухода в минус пессимистичной траектории (null — нет). */
  firstGapOut: string | null;
  /** Первый день ухода в минус ожидаемой траектории (null — нет). */
  firstGapIn: string | null;
}

const D0 = new Prisma.Decimal(0);

@Injectable()
export class ForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planning: PlanningService,
    private readonly balance: BalanceService,
  ) {}

  async build(workspaceId: string, horizonDays = 60): Promise<ForecastReport> {
    // Горизонт заполнен: материализуем регулярку до расчёта.
    await this.planning.materialize(workspaceId, Math.max(horizonDays, 45));

    const now = new Date();
    const today = startOfDay(now);
    const t = businessDayParts(now);
    const horizonEnd = businessInstant(t.y, t.mo, t.d + horizonDays, 23);

    const [opening, planned, inflows] = await Promise.all([
      this.balance.cashTotal(workspaceId),
      this.prisma.plannedPayment.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          status: 'PLANNED',
          dueDate: { lte: horizonEnd },
        },
        select: { dueDate: true, amount: true },
      }),
      this.expectedInflows(workspaceId, now),
    ]);

    // Дневные корзины: ключ — индекс дня от «сегодня» (0..horizonDays).
    const outByDay = new Map<number, Prisma.Decimal>();
    const inByDay = new Map<number, Prisma.Decimal>();
    const DAY_MS = 86_400_000;
    const dayIndex = (d: Date) => {
      const idx = Math.round((startOfDay(d).getTime() - today.getTime()) / DAY_MS);
      return idx < 0 ? 0 : idx; // просроченные оттоки — на сегодня
    };

    for (const p of planned) {
      const idx = dayIndex(p.dueDate);
      outByDay.set(idx, (outByDay.get(idx) ?? D0).plus(p.amount));
    }

    let overdueExpectedIn = D0;
    let inflowTotal = D0;
    for (const f of inflows) {
      const idx = Math.round((startOfDay(f.dueDate).getTime() - today.getTime()) / DAY_MS);
      if (idx < 0) {
        // Просроченные ожидания — не опора для прогноза, только справка.
        overdueExpectedIn = overdueExpectedIn.plus(f.amount);
        continue;
      }
      if (idx > horizonDays) continue;
      inByDay.set(idx, (inByDay.get(idx) ?? D0).plus(f.amount));
      inflowTotal = inflowTotal.plus(f.amount);
    }

    const points: ForecastPoint[] = [];
    let runOut = opening;
    let runIn = opening;
    let outTotal = D0;
    let firstGapOut: string | null = null;
    let firstGapIn: string | null = null;
    for (let i = 0; i <= horizonDays; i++) {
      const out = outByDay.get(i) ?? D0;
      const inn = inByDay.get(i) ?? D0;
      outTotal = outTotal.plus(out);
      runOut = runOut.minus(out);
      runIn = runIn.minus(out).plus(inn);
      const date = businessInstant(t.y, t.mo, t.d + i).toISOString();
      if (firstGapOut === null && runOut.lessThan(0)) firstGapOut = date;
      if (firstGapIn === null && runIn.lessThan(0)) firstGapIn = date;
      points.push({
        date,
        out: out.toFixed(2),
        in: inn.toFixed(2),
        balanceOut: runOut.toFixed(2),
        balance: runIn.toFixed(2),
      });
    }

    return {
      horizonDays,
      asOf: now.toISOString(),
      opening: opening.toFixed(2),
      points,
      totals: { out: outTotal.toFixed(2), in: inflowTotal.toFixed(2) },
      overdueExpectedIn: overdueExpectedIn.toFixed(2),
      firstGapOut,
      firstGapIn,
    };
  }

  /** Непокрытые строки графиков платежей открытых заказов → ожидаемые притоки. */
  private async expectedInflows(
    workspaceId: string,
    asOf: Date,
  ): Promise<Array<{ dueDate: Date; amount: Prisma.Decimal }>> {
    const orders = await this.prisma.order.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'OPEN',
        schedule: { some: { deletedAt: null } },
      },
      select: {
        totalAmount: true,
        paidAmount: true,
        schedule: {
          where: { deletedAt: null },
          orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }],
        },
      },
    });
    const rows: Array<{ dueDate: Date; amount: Prisma.Decimal }> = [];
    for (const o of orders) {
      const view = scheduleView(o.schedule, o.paidAmount, o.totalAmount, asOf);
      if (!view) continue;
      for (const e of view.entries) {
        const remaining = new Prisma.Decimal(e.remaining);
        if (remaining.lessThanOrEqualTo(0)) continue;
        rows.push({ dueDate: new Date(e.dueDate), amount: remaining });
      }
    }
    return rows;
  }
}
