import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';

@Injectable()
export class WarehouseRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: TxClient): TxClient | PrismaService {
    return tx ?? this.prisma;
  }

  list(workspaceId: string, opts: { search?: string; includeArchived?: boolean }) {
    return this.prisma.warehouseItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(opts.includeArchived ? {} : { isArchived: false }),
        ...(opts.search
          ? {
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { sku: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
      take: 300,
    });
  }

  findById(workspaceId: string, id: string, tx?: TxClient) {
    return this.db(tx).warehouseItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
  }

  /**
   * Блокирует строку склада на время транзакции (`SELECT … FOR UPDATE`) и
   * возвращает её. Нужен для read-modify-write (закупка/продажа/возврат):
   * Prisma не умеет FOR UPDATE, а без блокировки два параллельных finalize
   * читают один и тот же qty/avgCost и затирают друг друга (lost update,
   * oversell). Требует tx (UoW) — вне транзакции блокировка бессмысленна.
   * Блокировка снимается на commit/rollback транзакции.
   */
  async lockForUpdate(tx: TxClient, workspaceId: string, id: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WarehouseItem"
      WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL
      FOR UPDATE`;
    if (locked.length === 0) return null;
    // Полную строку читаем уже под удержанной блокировкой — данные консистентны.
    return this.findById(workspaceId, id, tx);
  }

  create(data: Prisma.WarehouseItemCreateInput, tx?: TxClient) {
    return this.db(tx).warehouseItem.create({ data });
  }

  update(id: string, data: Prisma.WarehouseItemUpdateInput, tx?: TxClient) {
    return this.db(tx).warehouseItem.update({ where: { id }, data });
  }

  softDelete(id: string, tx?: TxClient) {
    return this.db(tx).warehouseItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
