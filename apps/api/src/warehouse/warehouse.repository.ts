import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StockMovementType, StockLotSource, LotConsumptionKind } from '@prisma/client';
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

  // ─────────────────────────── FIFO: партии (StockLot) ───────────────────────────

  /**
   * Блокирует ОТКРЫТЫЕ партии позиции (`SELECT … FOR UPDATE`) в FIFO-порядке
   * (receivedAt ASC, seq ASC) и возвращает их. Вызывается ПОСЛЕ lockForUpdate на
   * строке WarehouseItem (якорь сериализации SKU) — лок на партии вложен в него.
   * qtyRemaining/unitCost приходят строками (::text) — точность Decimal не теряем.
   */
  async lockOpenLots(tx: TxClient, workspaceId: string, warehouseItemId: string) {
    const rows = await tx.$queryRaw<
      Array<{ id: string; qtyRemaining: string; unitCost: string; supplierId: string | null }>
    >`
      SELECT "id", "qtyRemaining"::text AS "qtyRemaining", "unitCost"::text AS "unitCost", "supplierId"
      FROM "StockLot"
      WHERE "workspaceId" = ${workspaceId}
        AND "warehouseItemId" = ${warehouseItemId}
        AND "qtyRemaining" > 0
        AND "deletedAt" IS NULL
      ORDER BY "receivedAt" ASC, "seq" ASC
      FOR UPDATE`;
    return rows.map((r) => ({
      id: r.id,
      qtyRemaining: new Prisma.Decimal(r.qtyRemaining),
      unitCost: new Prisma.Decimal(r.unitCost),
      supplierId: r.supplierId,
    }));
  }

  createLot(
    data: {
      workspaceId: string;
      warehouseItemId: string;
      qtyInitial: Prisma.Decimal;
      qtyRemaining: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      sourceType: StockLotSource;
      sourceId?: string | null;
      purchaseLineId?: string | null;
      supplierId?: string | null;
      accountId?: string | null;
      receivedAt: Date;
      createdById: string;
    },
    tx?: TxClient,
  ) {
    return this.db(tx).stockLot.create({
      data: {
        workspaceId: data.workspaceId,
        warehouseItemId: data.warehouseItemId,
        qtyInitial: data.qtyInitial,
        qtyRemaining: data.qtyRemaining,
        unitCost: data.unitCost,
        sourceType: data.sourceType,
        sourceId: data.sourceId ?? null,
        purchaseLineId: data.purchaseLineId ?? null,
        supplierId: data.supplierId ?? null,
        accountId: data.accountId ?? null,
        receivedAt: data.receivedAt,
        createdById: data.createdById,
      },
    });
  }

  updateLotRemaining(lotId: string, qtyRemaining: Prisma.Decimal, tx?: TxClient) {
    return this.db(tx).stockLot.update({
      where: { id: lotId },
      data: { qtyRemaining },
    });
  }

  /** Append-only запись потребления/реверса партии (со снимком unitCost). */
  recordConsumption(
    data: {
      workspaceId: string;
      lotId: string;
      movementId: string;
      orderItemId?: string | null;
      qty: Prisma.Decimal; // знаковая: + CONSUME, − REVERSAL
      unitCost: Prisma.Decimal;
      kind: LotConsumptionKind;
      reversalOfId?: string | null;
    },
    tx?: TxClient,
  ) {
    return this.db(tx).lotConsumption.create({
      data: {
        workspaceId: data.workspaceId,
        lotId: data.lotId,
        movementId: data.movementId,
        orderItemId: data.orderItemId ?? null,
        qty: data.qty,
        unitCost: data.unitCost,
        kind: data.kind,
        reversalOfId: data.reversalOfId ?? null,
      },
    });
  }

  /**
   * Агрегаты открытых партий позиции для пересчёта derived-кэшей WarehouseItem:
   * qty = Σ qtyRemaining, value = Σ(qtyRemaining*unitCost). Строками (::text).
   */
  async lotAggregates(tx: TxClient, workspaceId: string, warehouseItemId: string) {
    const rows = await tx.$queryRaw<Array<{ qty: string; value: string }>>`
      SELECT COALESCE(SUM("qtyRemaining"), 0)::text AS qty,
             COALESCE(SUM("qtyRemaining" * "unitCost"), 0)::text AS value
      FROM "StockLot"
      WHERE "workspaceId" = ${workspaceId}
        AND "warehouseItemId" = ${warehouseItemId}
        AND "qtyRemaining" > 0
        AND "deletedAt" IS NULL`;
    return {
      qty: new Prisma.Decimal(rows[0]?.qty ?? '0'),
      value: new Prisma.Decimal(rows[0]?.value ?? '0'),
    };
  }

  /**
   * Чистое потребление по строке заказа из леджера: netQty = Σ signed qty,
   * netCost = Σ signed (qty*unitCost). CONSUME даёт +, REVERSAL даёт − (qty знаковая).
   * Источник истины для OrderItem.unitCostAtSale (= netCost/netQty).
   */
  async netConsumedForOrderItem(tx: TxClient, workspaceId: string, orderItemId: string) {
    const rows = await tx.$queryRaw<Array<{ qty: string; cost: string }>>`
      SELECT COALESCE(SUM("qty"), 0)::text AS qty,
             COALESCE(SUM("qty" * "unitCost"), 0)::text AS cost
      FROM "LotConsumption"
      WHERE "workspaceId" = ${workspaceId}
        AND "orderItemId" = ${orderItemId}`;
    return {
      qty: new Prisma.Decimal(rows[0]?.qty ?? '0'),
      cost: new Prisma.Decimal(rows[0]?.cost ?? '0'),
    };
  }

  /**
   * Реверсируемые потребления строки заказа в LIFO-порядке (последнее списанное —
   * первым возвращается). remaining = CONSUME.qty − Σ|уже реверсированного|.
   * Возвращает только строки с remaining > 0.
   */
  async reversibleConsumptionsForOrderItem(
    tx: TxClient,
    workspaceId: string,
    orderItemId: string,
  ) {
    const rows = await tx.$queryRaw<
      Array<{ id: string; lotId: string; remaining: string; unitCost: string }>
    >`
      SELECT c."id",
             c."lotId",
             (c."qty" - COALESCE(
               (SELECT SUM(-r."qty") FROM "LotConsumption" r
                 WHERE r."reversalOfId" = c."id" AND r."kind" = 'REVERSAL'), 0))::text AS remaining,
             c."unitCost"::text AS "unitCost"
      FROM "LotConsumption" c
      WHERE c."workspaceId" = ${workspaceId}
        AND c."orderItemId" = ${orderItemId}
        AND c."kind" = 'CONSUME'
      ORDER BY c."createdAt" DESC, c."id" DESC`;
    return rows
      .map((r) => ({
        id: r.id,
        lotId: r.lotId,
        remaining: new Prisma.Decimal(r.remaining),
        unitCost: new Prisma.Decimal(r.unitCost),
      }))
      .filter((r) => r.remaining.greaterThan(0));
  }
}
