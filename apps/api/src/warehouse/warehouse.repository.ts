import { Injectable } from '@nestjs/common';
import type { Prisma, StockMovementType } from '@prisma/client';
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

  /**
   * Append-only журнал движений склада. Без soft-delete — записи неизменяемы.
   * Пишется той же `tx`, что и изменение остатка, чтобы движение и факт
   * совпадали атомарно.
   */
  recordMovement(
    data: {
      workspaceId: string;
      warehouseItemId: string;
      type: StockMovementType;
      qtyDelta: Prisma.Decimal;
      qtyAfter: Prisma.Decimal;
      unitCost?: Prisma.Decimal | null;
      refType?: string | null;
      refId?: string | null;
      reason?: string | null;
      createdById: string;
    },
    tx?: TxClient,
  ) {
    return this.db(tx).stockMovement.create({
      data: {
        workspaceId: data.workspaceId,
        warehouseItemId: data.warehouseItemId,
        type: data.type,
        qtyDelta: data.qtyDelta,
        qtyAfter: data.qtyAfter,
        unitCost: data.unitCost ?? null,
        refType: data.refType ?? null,
        refId: data.refId ?? null,
        reason: data.reason ?? null,
        createdById: data.createdById,
      },
    });
  }

  /** Список движений позиции, новые сверху. */
  listMovements(workspaceId: string, warehouseItemId: string, tx?: TxClient) {
    return this.db(tx).stockMovement.findMany({
      where: { workspaceId, warehouseItemId },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  /**
   * Позиции ниже точки дозаказа: reorderPoint задан И qty <= reorderPoint.
   * Сравнение колонки с колонкой Prisma-фильтром не выразить — сырой SQL.
   * Только активные и не-архивные.
   */
  lowStock(workspaceId: string, tx?: TxClient) {
    return this.db(tx).$queryRaw<
      Array<{
        id: string;
        name: string;
        sku: string | null;
        unit: string;
        qty: Prisma.Decimal;
        avgCost: Prisma.Decimal;
        reorderPoint: Prisma.Decimal | null;
      }>
    >`
      SELECT "id", "name", "sku", "unit", "qty", "avgCost", "reorderPoint"
      FROM "WarehouseItem"
      WHERE "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND "isArchived" = false
        AND "reorderPoint" IS NOT NULL
        AND "qty" <= "reorderPoint"
      ORDER BY "name" ASC
      LIMIT 300`;
  }

  /** Поиск активных позиций по списку имён (для дедупа импорта по name). */
  findByNames(workspaceId: string, names: string[], tx?: TxClient) {
    return this.db(tx).warehouseItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        name: { in: names, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });
  }
}
