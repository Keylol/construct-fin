import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scheduleView } from '../orders/payment-schedule';

/**
 * Дебиторка (receivables): незакрытые долги клиентов по заказам.
 *
 * В выборку попадают заказы с paymentStatus ∈ {UNPAID, PARTIAL} (не PAID/
 * REFUNDED/OVERPAID), не удалённые. Долг по заказу = totalAmount − paidAmount.
 * Aging — по возрасту заказа от Order.createdAt до «текущей даты»:
 *   0–30 / 30–60 / 60+ дней. Граница попадает в верхнюю корзину
 *   (ровно 30 дней → корзина 30–60).
 *
 * РЕШЕНИЕ ПО РЕВЬЮ (подтверждено): отдельного поля даты счёта/отгрузки
 * (Order.date) в схеме нет; expectedDate — это план, closedAt может быть null
 * для ещё открытых заказов. createdAt — единственная всегда-присутствующая дата
 * возникновения долга, поэтому старим именно от неё.
 *
 * Группировка по клиенту + итоги по корзинам.
 */

export type AgingBucketKey = '0-30' | '30-60' | '60+';

const DAY_MS = 86_400_000;

export interface AgingBuckets {
  '0-30': string;
  '30-60': string;
  '60+': string;
}

export interface ReceivableOrder {
  orderId: string;
  number: string;
  createdAt: string;
  ageDays: number;
  bucket: AgingBucketKey;
  total: string;
  paid: string;
  due: string;
  /** F2: просрочено по графику платежей; null — графика нет. */
  overdueByPlan: string | null;
  /** F2: ближайший срок по графику (ISO); null — графика нет / всё погашено. */
  nextDueDate: string | null;
}

export interface ReceivableClientRow {
  clientId: string | null;
  clientName: string;
  due: string;
  /** F2: Σ просроченного по графикам заказов клиента. */
  overdueByPlan: string;
  buckets: AgingBuckets;
  orders: ReceivableOrder[];
}

export interface ReceivablesReport {
  asOf: string;
  totalDue: string;
  /** F2: Σ просроченного по графикам всех заказов выборки. */
  overdueByPlanTotal: string;
  buckets: AgingBuckets;
  clients: ReceivableClientRow[];
}

function bucketFor(ageDays: number): AgingBucketKey {
  if (ageDays < 30) return '0-30';
  if (ageDays < 60) return '30-60';
  return '60+';
}

function emptyBuckets(): Record<AgingBucketKey, Prisma.Decimal> {
  return {
    '0-30': new Prisma.Decimal(0),
    '30-60': new Prisma.Decimal(0),
    '60+': new Prisma.Decimal(0),
  };
}

function freezeBuckets(b: Record<AgingBucketKey, Prisma.Decimal>): AgingBuckets {
  return {
    '0-30': b['0-30'].toFixed(2),
    '30-60': b['30-60'].toFixed(2),
    '60+': b['60+'].toFixed(2),
  };
}

interface ClientAcc {
  clientId: string | null;
  clientName: string;
  due: Prisma.Decimal;
  overdueByPlan: Prisma.Decimal;
  buckets: Record<AgingBucketKey, Prisma.Decimal>;
  orders: ReceivableOrder[];
}

@Injectable()
export class ReceivablesService {
  constructor(private readonly prisma: PrismaService) {}

  async build(workspaceId: string, asOf: Date = new Date()): Promise<ReceivablesReport> {
    const orders = await this.prisma.order.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        // DE2: отменённые заказы (CANCELLED) — не дебиторка, даже если статус
        // оплаты остался UNPAID/PARTIAL. Иначе фантомный долг вечно стареет в 60+.
        status: { notIn: ['CANCELLED'] },
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
      },
      select: {
        id: true,
        number: true,
        clientId: true,
        createdAt: true,
        totalAmount: true,
        paidAmount: true,
        client: { select: { name: true } },
        // DE1: строки — для чистой выручки (total − стоимость возвратов).
        items: { where: { deletedAt: null }, select: { returnedQty: true, unitPrice: true } },
        // F2: строки графика — для «просрочено по плану» (обычно 0–4 строки).
        schedule: {
          where: { deletedAt: null },
          orderBy: [{ dueDate: 'asc' }, { seq: 'asc' }],
        },
      },
    });

    const totalBuckets = emptyBuckets();
    let totalDue = new Prisma.Decimal(0);
    let overdueByPlanTotal = new Prisma.Decimal(0);
    const byClient = new Map<string, ClientAcc>();

    for (const o of orders) {
      const total = new Prisma.Decimal(o.totalAmount);
      const paid = new Prisma.Decimal(o.paidAmount);
      // DE1: долг по ЧИСТОЙ выручке (total − стоимость возвращённых единиц), не по
      // сырому total. Возврат товара уменьшает и paid (рефанд), и netRevenue —
      // фантомный долг из RMA исчезает. clamp на 0.
      const returnedValue = o.items.reduce(
        (acc, it) => acc.plus(new Prisma.Decimal(it.returnedQty).times(it.unitPrice)),
        new Prisma.Decimal(0),
      );
      const netRevenue = Prisma.Decimal.max(total.minus(returnedValue), new Prisma.Decimal(0));
      const due = netRevenue.minus(paid);
      // Отрицательный/нулевой долг по заказу не считаем дебиторкой
      // (защита от рассинхрона кэша paidAmount).
      if (due.lessThanOrEqualTo(0)) continue;

      const ageDays = Math.floor((asOf.getTime() - o.createdAt.getTime()) / DAY_MS);
      const safeAge = ageDays < 0 ? 0 : ageDays;
      const bucket = bucketFor(safeAge);

      // F2: просрочка по формальному графику против чистой выручки (не сырого total).
      const plan = scheduleView(o.schedule, paid, netRevenue, asOf);
      const overdueByPlan = plan ? new Prisma.Decimal(plan.summary.overdueAmount) : null;

      totalDue = totalDue.plus(due);
      totalBuckets[bucket] = totalBuckets[bucket].plus(due);
      if (overdueByPlan) overdueByPlanTotal = overdueByPlanTotal.plus(overdueByPlan);

      const key = o.clientId ?? ' __no_client__';
      const acc =
        byClient.get(key) ??
        ({
          clientId: o.clientId,
          clientName: o.clientId ? o.client?.name ?? '—' : 'Без клиента',
          due: new Prisma.Decimal(0),
          overdueByPlan: new Prisma.Decimal(0),
          buckets: emptyBuckets(),
          orders: [],
        } satisfies ClientAcc);
      acc.due = acc.due.plus(due);
      if (overdueByPlan) acc.overdueByPlan = acc.overdueByPlan.plus(overdueByPlan);
      acc.buckets[bucket] = acc.buckets[bucket].plus(due);
      acc.orders.push({
        orderId: o.id,
        number: o.number,
        createdAt: o.createdAt.toISOString(),
        ageDays: safeAge,
        bucket,
        total: total.toFixed(2),
        paid: paid.toFixed(2),
        due: due.toFixed(2),
        overdueByPlan: overdueByPlan ? overdueByPlan.toFixed(2) : null,
        nextDueDate: plan?.summary.nextDueDate ?? null,
      });
      byClient.set(key, acc);
    }

    const clients: ReceivableClientRow[] = Array.from(byClient.values()).map((acc) => ({
      clientId: acc.clientId,
      clientName: acc.clientName,
      due: acc.due.toFixed(2),
      overdueByPlan: acc.overdueByPlan.toFixed(2),
      buckets: freezeBuckets(acc.buckets),
      orders: acc.orders.sort((a, b) => b.ageDays - a.ageDays),
    }));
    clients.sort((a, b) => Number(b.due) - Number(a.due));

    return {
      asOf: asOf.toISOString(),
      totalDue: totalDue.toFixed(2),
      overdueByPlanTotal: overdueByPlanTotal.toFixed(2),
      buckets: freezeBuckets(totalBuckets),
      clients,
    };
  }
}
