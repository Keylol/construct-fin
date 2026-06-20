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

  /**
   * Курсор-пагинация списка заказов («Загрузить ещё»). Стабильный порядок —
   * createdAt desc + id desc (тай-брейк), курсор по id, выборка take+1 для
   * определения nextCursor. limit по умолчанию 100, максимум 200.
   */
  async list(
    workspaceId: string,
    opts: { status?: string; clientId?: string; search?: string; cursor?: string; limit?: number },
  ) {
    const limit = opts.limit ?? 100;
    const rows = await this.prisma.order.findMany({
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.id : null };
  }

  /**
   * B2: row-lock строки заказа внутри транзакции (SELECT … FOR UPDATE).
   * Сериализует конкурентные мутации одного заказа: второй вызов ждёт коммита
   * первого, после чего перечитывает СВЕЖЕЕ состояние (см. findById с tx) —
   * иначе оба читали бы устаревший снапшот и давали oversell/double-ship.
   */
  async lockForUpdate(tx: TxClient, workspaceId: string, id: string): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM "Order"
      WHERE id = ${id} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
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
        attachments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, filename: true, mimeType: true, size: true, createdAt: true },
        },
      },
    });
  }

  /**
   * Следующий читаемый номер заказа в рамках workspace: ORD-2026-0042.
   *
   * B5: MAX по ЧИСЛОВОМУ значению последовательности, а не лексикографически по
   * строке — иначе после 9999 строка «ORD-2026-9999» сортируется ПОЗЖЕ
   * «ORD-2026-10000» и номер регрессирует к 10000 навсегда. Гонку двух
   * параллельных create закрывает partial-unique индекс по number (P2002) +
   * ретрай в OrderService.create.
   */
  async nextNumber(workspaceId: string, tx?: TxClient): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `ORD-${year}-`;
    const rows = await this.db(tx).$queryRaw<{ seq: number }[]>`
      SELECT COALESCE(MAX(CAST(substring(number FROM '[0-9]+$') AS INTEGER)), 0) AS seq
      FROM "Order"
      WHERE "workspaceId" = ${workspaceId} AND number LIKE ${prefix + '%'}
    `;
    const next = (rows[0]?.seq ?? 0) + 1;
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
