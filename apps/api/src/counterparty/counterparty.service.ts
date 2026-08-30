import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCounterpartyDto,
  UpdateCounterpartyDto,
  ListCounterpartiesQuery,
} from './counterparty.dto';

@Injectable()
export class CounterpartyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Список контрагентов со сводкой по заказам: сколько заказов, на какую сумму
   * и сколько человек должен сейчас.
   *
   * Без сводки плитка клиента показывала бы только имя — за ней нельзя следить
   * («кто должен», «кто приносит больше»), а открывать карточку ради двух цифр
   * незачем. Считаем одним группировочным запросом по всем заказам
   * пространства, а не по заказу на контрагента: клиентов уже под полсотни.
   */
  async list(workspaceId: string, query: ListCounterpartiesQuery) {
    const rows = await this.listRows(workspaceId, query);
    const grouped = await this.prisma.order.groupBy({
      by: ['clientId'],
      where: { workspaceId, deletedAt: null, status: { not: 'CANCELLED' }, clientId: { not: null } },
      _count: { _all: true },
      _sum: { totalAmount: true, paidAmount: true },
      _max: { createdAt: true },
    });
    const byClient = new Map(grouped.map((g) => [g.clientId, g]));
    // Последний заказ каждого клиента: с плитки проваливаются сразу в него,
    // когда заказ единственный — лишний экран между кликом и делом не нужен.
    const lastOrders = await this.prisma.order.findMany({
      where: { workspaceId, deletedAt: null, status: { not: 'CANCELLED' }, clientId: { not: null } },
      select: { id: true, clientId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const lastByClient = new Map<string, string>();
    for (const o of lastOrders) {
      if (o.clientId && !lastByClient.has(o.clientId)) lastByClient.set(o.clientId, o.id);
    }
    return rows.map((c) => {
      const g = byClient.get(c.id);
      const total = g?._sum.totalAmount ?? new Prisma.Decimal(0);
      const paid = g?._sum.paidAmount ?? new Prisma.Decimal(0);
      const debt = Prisma.Decimal.max(total.minus(paid), new Prisma.Decimal(0));
      return {
        ...c,
        summary: {
          ordersCount: g?._count._all ?? 0,
          ordersTotal: total.toFixed(2),
          debt: debt.toFixed(2),
          lastOrderAt: g?._max.createdAt?.toISOString() ?? null,
          lastOrderId: lastByClient.get(c.id) ?? null,
        },
      };
    });
  }

  private listRows(workspaceId: string, query: ListCounterpartiesQuery) {
    return this.prisma.counterparty.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.includeArchived ? {} : { isArchived: false }),
        ...(query.role ? { role: query.role } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { contact: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: 200,
    });
  }

  create(workspaceId: string, input: CreateCounterpartyDto) {
    return this.prisma.counterparty.create({
      data: {
        workspaceId,
        name: input.name,
        role: input.role ?? 'OTHER',
        contact: input.contact ?? null,
        note: input.note ?? null,
        inn: input.inn ?? null,
        source: input.source ?? null,
        position: input.position ?? null,
        payRate: input.payRate != null ? new Prisma.Decimal(input.payRate) : null,
      },
    });
  }

  async update(workspaceId: string, id: string, input: UpdateCounterpartyDto) {
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Counterparty not found');
    return this.prisma.counterparty.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        role: input.role ?? undefined,
        contact: input.contact === undefined ? undefined : input.contact,
        note: input.note === undefined ? undefined : input.note,
        inn: input.inn === undefined ? undefined : input.inn,
        source: input.source === undefined ? undefined : input.source,
        position: input.position === undefined ? undefined : input.position,
        payRate:
          input.payRate === undefined
            ? undefined
            : input.payRate === null
              ? null
              : new Prisma.Decimal(input.payRate),
        isArchived: input.isArchived ?? undefined,
      },
    });
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.counterparty.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Counterparty not found');
    await this.prisma.counterparty.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
