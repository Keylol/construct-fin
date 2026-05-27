import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';

/**
 * Репозиторий заказов. Инкапсулирует все запросы к таблицам Order/OrderItem.
 *
 * Пластичность: сервисы зависят от этого класса, а не от PrismaService.
 * `.using(tx)` возвращает экземпляр, привязанный к транзакции UoW; без
 * аргумента работает на общем подключении.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Клиент БД: либо переданная транзакция, либо общий пул. */
  private db(tx?: TxClient): TxClient | PrismaService {
    return tx ?? this.prisma;
  }

  list(workspaceId: string, opts: { status?: string; clientId?: string; search?: string }) {
    return this.prisma.order.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(opts.status ? { status: opts.status as Prisma.EnumOrderStatusFilter } : {}),
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.search
          ? {
              OR: [
                { number: { contains: opts.search, mode: 'insensitive' } },
                { title: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        client: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
  }

  findById(workspaceId: string, id: string, tx?: TxClient) {
    return this.db(tx).order.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        client: true,
        items: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        transactions: {
          where: { deletedAt: null },
          orderBy: { date: 'desc' },
        },
      },
    });
  }

  /** Следующий читаемый номер заказа в рамках workspace: ORD-2026-0042. */
  async nextNumber(workspaceId: string, tx?: TxClient): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `ORD-${year}-`;
    const last = await this.db(tx).order.findFirst({
      where: { workspaceId, number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const lastSeq = last ? Number.parseInt(last.number.slice(prefix.length), 10) : 0;
    const next = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  create(data: Prisma.OrderCreateInput, tx?: TxClient) {
    return this.db(tx).order.create({ data });
  }

  update(id: string, data: Prisma.OrderUpdateInput, tx?: TxClient) {
    return this.db(tx).order.update({ where: { id }, data });
  }

  softDelete(id: string, tx?: TxClient) {
    return this.db(tx).order.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
