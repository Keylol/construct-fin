import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildDiscrepancies,
  type DiscrepancyCheck,
  type SnapshotDeal,
  type SnapshotOrder,
} from './crm-discrepancies';

/**
 * Горизонт расхождений по умолчанию. В CRM лежит история за годы, а учёт в
 * приложении моложе: без горизонта экран забьют сделки позапрошлого сезона, и
 * смотреть его перестанут. Квартал — период, за который ещё можно что-то
 * исправить.
 */
export const DEFAULT_SINCE_DAYS = 90;

/**
 * Расхождения между amoCRM и учётом. Считает снимок и отдаёт готовые проверки —
 * те же данные питают и список на экране, и счётчик «Сделать сейчас» на
 * главной.
 */
@Injectable()
export class CrmDiscrepancyService {
  constructor(private readonly prisma: PrismaService) {}

  async discrepancies(
    workspaceId: string,
    sinceDays = DEFAULT_SINCE_DAYS,
  ): Promise<{ checks: DiscrepancyCheck[]; sinceDays: number; since: string }> {
    const now = new Date();
    // sinceDays = 0 — «за всё время»: владелец сам решает, смотреть ли хвост.
    const since = sinceDays > 0 ? new Date(now.getTime() - sinceDays * 86_400_000) : new Date(0);

    const connection = await this.prisma.crmConnection.findFirst({
      where: { workspaceId, deletedAt: null },
      select: { id: true, status: true, lastSyncAt: true, lastSyncError: true },
    });

    const [deals, orders] = await Promise.all([
      connection
        ? this.prisma.crmDeal.findMany({
            where: { workspaceId, connectionId: connection.id },
            select: {
              id: true,
              externalId: true,
              name: true,
              statusName: true,
              price: true,
              isWon: true,
              isClosed: true,
              dismissedAt: true,
              remoteClosedAt: true,
              remoteUpdatedAt: true,
              order: {
                select: {
                  id: true,
                  number: true,
                  status: true,
                  totalAmount: true,
                  paidAmount: true,
                  createdAt: true,
                  client: { select: { name: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      this.prisma.order.findMany({
        where: { workspaceId, deletedAt: null },
        select: {
          id: true,
          number: true,
          status: true,
          totalAmount: true,
          paidAmount: true,
          createdAt: true,
          client: { select: { name: true } },
          _count: { select: { crmDeals: true } },
        },
      }),
    ]);

    const mappedDeals: SnapshotDeal[] = deals.map((d) => ({
      id: d.id,
      externalId: d.externalId,
      name: d.name,
      statusName: d.statusName,
      price: d.price.toFixed(2),
      isWon: d.isWon,
      isClosed: d.isClosed,
      dismissedAt: d.dismissedAt,
      remoteClosedAt: d.remoteClosedAt,
      remoteUpdatedAt: d.remoteUpdatedAt,
      order: d.order
        ? {
            id: d.order.id,
            number: d.order.number,
            status: d.order.status,
            totalAmount: d.order.totalAmount.toFixed(2),
            paidAmount: d.order.paidAmount.toFixed(2),
            clientName: d.order.client?.name ?? null,
            createdAt: d.order.createdAt,
            hasDeal: true,
          }
        : null,
    }));

    const mappedOrders: SnapshotOrder[] = orders.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      totalAmount: o.totalAmount.toFixed(2),
      paidAmount: o.paidAmount.toFixed(2),
      clientName: o.client?.name ?? null,
      createdAt: o.createdAt,
      hasDeal: o._count.crmDeals > 0,
    }));

    return {
      checks: buildDiscrepancies(mappedDeals, mappedOrders, connection, { since, now }),
      sinceDays,
      since: since.toISOString(),
    };
  }
}
