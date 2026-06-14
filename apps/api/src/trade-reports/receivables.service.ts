import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Дебиторка (receivables): незакрытые долги клиентов по заказам.
 *
 * В выборку попадают заказы с paymentStatus ∈ {UNPAID, PARTIAL} (не PAID/
 * REFUNDED/OVERPAID), не удалённые. Долг по заказу = totalAmount − paidAmount.
 * Aging — по возрасту заказа от Order.createdAt до «текущей даты»:
 *   0–30 / 30–60 / 60+ дней. Граница попадает в верхнюю корзину
 *   (ровно 30 дней → корзина 30–60).
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
}

export interface ReceivableClientRow {
  clientId: string | null;
  clientName: string;
  due: string;
  buckets: AgingBuckets;
  orders: ReceivableOrder[];
}

export interface ReceivablesReport {
  asOf: string;
  totalDue: string;
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
      },
    });

    const totalBuckets = emptyBuckets();
    let totalDue = new Prisma.Decimal(0);
    const byClient = new Map<string, ClientAcc>();

    for (const o of orders) {
      const total = new Prisma.Decimal(o.totalAmount);
      const paid = new Prisma.Decimal(o.paidAmount);
      const due = total.minus(paid);
      // Отрицательный/нулевой долг по заказу не считаем дебиторкой
      // (защита от рассинхрона кэша paidAmount).
      if (due.lessThanOrEqualTo(0)) continue;

      const ageDays = Math.floor((asOf.getTime() - o.createdAt.getTime()) / DAY_MS);
      const safeAge = ageDays < 0 ? 0 : ageDays;
      const bucket = bucketFor(safeAge);

      totalDue = totalDue.plus(due);
      totalBuckets[bucket] = totalBuckets[bucket].plus(due);

      const key = o.clientId ?? ' __no_client__';
      const acc =
        byClient.get(key) ??
        ({
          clientId: o.clientId,
          clientName: o.clientId ? o.client?.name ?? '—' : 'Без клиента',
          due: new Prisma.Decimal(0),
          buckets: emptyBuckets(),
          orders: [],
        } satisfies ClientAcc);
      acc.due = acc.due.plus(due);
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
      });
      byClient.set(key, acc);
    }

    const clients: ReceivableClientRow[] = Array.from(byClient.values()).map((acc) => ({
      clientId: acc.clientId,
      clientName: acc.clientName,
      due: acc.due.toFixed(2),
      buckets: freezeBuckets(acc.buckets),
      orders: acc.orders.sort((a, b) => b.ageDays - a.ageDays),
    }));
    clients.sort((a, b) => Number(b.due) - Number(a.due));

    return {
      asOf: asOf.toISOString(),
      totalDue: totalDue.toFixed(2),
      buckets: freezeBuckets(totalBuckets),
      clients,
    };
  }
}
