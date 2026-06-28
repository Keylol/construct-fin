import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork, type TxClient } from '../common/unit-of-work';
import { WarehouseRepository } from './warehouse.repository';
import {
  consumePlan,
  reversePlan,
  weightedUnitCost,
  InsufficientStockError,
  type OpenLot,
} from '../common/fifo';
import { D, qty as roundQty, cost as roundCost, money, gt, sub, add } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { parseGenericXlsx } from '../import/parsers';
import type {
  CreateWarehouseItemDto,
  UpdateWarehouseItemDto,
  ListWarehouseQuery,
  AdjustStockDto,
  SetItemCostDto,
  SupplierReturnDto,
  WarehouseImportRow,
  WarehouseImportMapping,
} from './warehouse.dto';

export interface WarehouseImportPreview {
  headers: string[];
  created: WarehouseImportRow[];
  skipped: Array<{ name: string; reason: string }>;
  stats: { total: number; created: number; skipped: number };
}

/** Списанной строки заказа нет потреблений (до-миграционный заказ / удалённая позиция). */
export class NoConsumptionsError extends Error {
  constructor() {
    super('Нет потреблений для реверса');
    this.name = 'NoConsumptionsError';
  }
}

/** Результат FIFO-списания: сколько списано и точная стоимость списанных партий. */
export interface ConsumeResult {
  qtyConsumed: Prisma.Decimal;
  totalCost: Prisma.Decimal;
}

@Injectable()
export class WarehouseService {
  private readonly logger = new Logger(WarehouseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: WarehouseRepository,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  list(workspaceId: string, query: ListWarehouseQuery) {
    return this.repo.list(workspaceId, query);
  }

  async get(workspaceId: string, id: string) {
    const item = await this.repo.findById(workspaceId, id);
    if (!item) throw new NotFoundException('Warehouse item not found');
    return item;
  }

  async create(workspaceId: string, input: CreateWarehouseItemDto, userId: string) {
    // Cross-tenant guard: поставщик по умолчанию обязан принадлежать workspace,
    // иначе к позиции привязался бы чужой контрагент (его имя утекло бы в UI/возврат).
    await this.assertSupplier(workspaceId, input.defaultSupplierId);

    const openingQty = input.openingQty ? roundQty(input.openingQty) : D(0);

    // Без начального остатка — просто заводим позицию (qty/avgCost=0, без партий).
    if (!gt(openingQty, '0')) {
      return this.repo.create({
        workspace: { connect: { id: workspaceId } },
        name: input.name,
        sku: input.sku ?? null,
        unit: input.unit ?? 'шт',
        qty: D(0),
        avgCost: D(0),
        note: input.note ?? null,
        ...(input.defaultSupplierId
          ? { defaultSupplier: { connect: { id: input.defaultSupplierId } } }
          : {}),
      });
    }

    // С начальным остатком — атомарно: позиция + OPENING-лот + OPENING-движение.
    // (Раньше qty/avgCost ставились напрямую без движения → латентный разрыв
    // qty == Σ движений. Теперь остаток материализован партией.)
    const openingCost = input.openingCost ? roundCost(input.openingCost) : D(0);
    return this.uow.run(async (tx) => {
      const item = await this.repo.create(
        {
          workspace: { connect: { id: workspaceId } },
          name: input.name,
          sku: input.sku ?? null,
          unit: input.unit ?? 'шт',
          qty: D(0),
          avgCost: D(0),
          note: input.note ?? null,
          ...(input.defaultSupplierId
            ? { defaultSupplier: { connect: { id: input.defaultSupplierId } } }
            : {}),
        },
        tx,
      );
      await this.openingLot(tx, workspaceId, item.id, openingQty, openingCost, userId);
      await this.recomputeCaches(tx, workspaceId, item.id);
      return this.repo.findById(workspaceId, item.id, tx);
    });
  }

  async update(workspaceId: string, id: string, input: UpdateWarehouseItemDto) {
    await this.get(workspaceId, id);
    await this.assertSupplier(workspaceId, input.defaultSupplierId);
    return this.repo.update(id, {
      name: input.name ?? undefined,
      sku: input.sku === undefined ? undefined : input.sku,
      unit: input.unit ?? undefined,
      note: input.note === undefined ? undefined : input.note,
      isArchived: input.isArchived ?? undefined,
      ...(input.defaultSupplierId !== undefined
        ? {
            defaultSupplier: input.defaultSupplierId
              ? { connect: { id: input.defaultSupplierId } }
              : { disconnect: true },
          }
        : {}),
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.repo.softDelete(id);
    return { ok: true };
  }

  /** Счёт обязан принадлежать workspace (cross-tenant guard). */
  private async assertAccount(workspaceId: string, accountId: string, tx?: TxClient) {
    const db = tx ?? this.prisma;
    const acc = await db.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw new NotFoundException('Счёт не найден в этом пространстве');
  }

  /** Контрагент-поставщик (если задан) обязан принадлежать workspace. */
  private async assertSupplier(
    workspaceId: string,
    supplierId: string | null | undefined,
    tx?: TxClient,
  ) {
    if (!supplierId) return;
    const db = tx ?? this.prisma;
    const sup = await db.counterparty.findFirst({
      where: { id: supplierId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!sup) throw new NotFoundException('Поставщик не найден в этом пространстве');
  }

  // ─────────────────────────── FIFO-примитивы (private) ───────────────────────────

  /**
   * Пересчитывает derived-кэши WarehouseItem (qty, avgCost) из открытых партий.
   * Вызывается ПОД локом строки позиции после каждой лот-операции. Истина — лоты:
   * qty = Σ qtyRemaining; avgCost = Σ(qtyRem*unitCost)/Σ qtyRemaining (0 если пусто —
   * guard деления на ноль, I9).
   */
  private async recomputeCaches(tx: TxClient, workspaceId: string, itemId: string) {
    const agg = await this.repo.lotAggregates(tx, workspaceId, itemId);
    const newQty = roundQty(agg.qty);
    const newAvg = gt(agg.qty, '0') ? roundCost(agg.value.div(agg.qty)) : D(0);
    await this.repo.update(itemId, { qty: newQty, avgCost: newAvg }, tx);
  }

  /** Создаёт OPENING-партию (начальный остаток / импорт). */
  private async openingLot(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    qtyInitial: Prisma.Decimal,
    unitCost: Prisma.Decimal,
    userId: string,
  ) {
    await this.repo.createLot(
      {
        workspaceId,
        warehouseItemId: itemId,
        qtyInitial,
        qtyRemaining: qtyInitial,
        unitCost,
        sourceType: 'OPENING',
        receivedAt: new Date(),
        createdById: userId,
      },
      tx,
    );
    await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'OPENING',
        qtyDelta: qtyInitial,
        qtyAfter: qtyInitial,
        unitCost,
        refType: 'Opening',
        createdById: userId,
      },
      tx,
    );
  }

  /**
   * FIFO-списание `consumeQty` с открытых партий позиции (ПОД локом строки).
   * Пишет одно движение `movementType` и LotConsumption(CONSUME) на каждую тронутую
   * партию. Возвращает движение и точную стоимость. Бросает InsufficientStockError
   * (через consumePlan), если суммарного остатка партий не хватает.
   *
   * `orderedLots` позволяет вызывающему задать приоритет (supplier-return); по
   * умолчанию — чистый FIFO из lockOpenLots.
   */
  private async consumeLots(params: {
    tx: TxClient;
    workspaceId: string;
    itemId: string;
    cachedQty: Prisma.Decimal;
    consumeQty: Prisma.Decimal;
    movementType: 'SALE' | 'RETURN_SUPPLIER' | 'ADJUSTMENT' | 'WRITE_OFF';
    userId: string;
    orderedLots?: OpenLot[];
    orderItemId?: string | null;
    ref?: { refType?: string; refId?: string };
    reason?: string | null;
  }): Promise<{ movementId: string; totalCost: Prisma.Decimal }> {
    const { tx, workspaceId, itemId, cachedQty, consumeQty, movementType, userId } = params;
    const lots =
      params.orderedLots ?? (await this.repo.lockOpenLots(tx, workspaceId, itemId));
    const plan = consumePlan(lots, consumeQty);
    const newQty = roundQty(sub(cachedQty, consumeQty));

    const movement = await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: movementType,
        qtyDelta: roundQty(consumeQty.negated()),
        qtyAfter: newQty,
        unitCost: weightedUnitCost(plan.totalCost, consumeQty),
        refType: params.ref?.refType ?? null,
        refId: params.ref?.refId ?? null,
        reason: params.reason ?? null,
        createdById: userId,
      },
      tx,
    );

    // qtyRemaining партий до шагов (для вычета). Map id→remaining.
    const remainingById = new Map(lots.map((l) => [l.id, l.qtyRemaining]));
    for (const step of plan.steps) {
      const before = remainingById.get(step.lotId) ?? D(0);
      const after = sub(before, step.qty);
      remainingById.set(step.lotId, after);
      await this.repo.updateLotRemaining(step.lotId, roundQty(after), tx);
      await this.repo.recordConsumption(
        {
          workspaceId,
          lotId: step.lotId,
          movementId: movement.id,
          orderItemId: params.orderItemId ?? null,
          qty: roundQty(step.qty), // + списание
          unitCost: step.unitCost,
          kind: 'CONSUME',
        },
        tx,
      );
    }
    await this.recomputeCaches(tx, workspaceId, itemId);
    return { movementId: movement.id, totalCost: plan.totalCost };
  }

  // ─────────── Инвентаризация / оценка ───────────

  /**
   * Инвентаризация: выставить остаток вручную (ПОД локом строки).
   *   • остаток падает → FIFO-списание разницы (ADJUSTMENT-движение + потребления);
   *   • остаток растёт → новая ADJUSTMENT-партия. Себестоимость излишка: явный
   *     dto.unitCost, иначе текущий avgCost; если открытых партий нет и unitCost
   *     не задан → 400 (не создаём 0-партию молча — она раздула бы маржу, реш. #2).
   */
  async adjust(workspaceId: string, id: string, dto: AdjustStockDto, userId: string) {
    return this.uow.run(async (tx) => {
      const item = await this.repo.lockForUpdate(tx, workspaceId, id);
      if (!item) throw new NotFoundException('Warehouse item not found');
      const newQty = roundQty(dto.newQty);
      const delta = roundQty(sub(newQty, item.qty));
      if (delta.isZero()) {
        return this.repo.findById(workspaceId, id, tx);
      }

      if (delta.isNegative()) {
        try {
          await this.consumeLots({
            tx,
            workspaceId,
            itemId: id,
            cachedQty: item.qty,
            consumeQty: delta.negated(),
            movementType: 'ADJUSTMENT',
            userId,
            ref: { refType: 'Adjust' },
            reason: dto.reason ?? null,
          });
        } catch (e) {
          if (e instanceof InsufficientStockError) {
            throw new BadRequestException(`«${item.name}»: ${e.message}`);
          }
          throw e;
        }
      } else {
        const agg = await this.repo.lotAggregates(tx, workspaceId, id);
        const hasOpenLots = gt(agg.qty, '0');
        let unitCost: Prisma.Decimal;
        if (dto.unitCost != null) {
          unitCost = roundCost(dto.unitCost);
        } else if (hasOpenLots) {
          unitCost = item.avgCost;
        } else {
          throw new BadRequestException(
            'Нет открытых партий: укажите себестоимость излишка (unitCost) для инвентаризации в плюс',
          );
        }
        await this.repo.createLot(
          {
            workspaceId,
            warehouseItemId: id,
            qtyInitial: delta,
            qtyRemaining: delta,
            unitCost,
            sourceType: 'ADJUSTMENT',
            receivedAt: new Date(),
            createdById: userId,
          },
          tx,
        );
        await this.repo.recordMovement(
          {
            workspaceId,
            warehouseItemId: id,
            type: 'ADJUSTMENT',
            qtyDelta: delta,
            qtyAfter: newQty,
            unitCost,
            reason: dto.reason ?? null,
            refType: 'Adjust',
            createdById: userId,
          },
          tx,
        );
        await this.recomputeCaches(tx, workspaceId, id);
      }
      return this.repo.findById(workspaceId, id, tx);
    });
  }

  /**
   * Установка себестоимости НЕоценённого начального остатка (avgCost=0): проставляет
   * unitCost всем открытым нулевым партиям позиции. Деньги НЕ двигаются (cash-basis).
   * Влияет только на будущие списания; уже проданное по 0 не переписывается (реверс
   * берёт снимок consumption.unitCost=0). Переоценка уже оценённого остатка запрещена.
   */
  async setCost(workspaceId: string, id: string, dto: SetItemCostDto, userId: string) {
    return this.uow.run(async (tx) => {
      const item = await this.repo.lockForUpdate(tx, workspaceId, id);
      if (!item) throw new NotFoundException('Warehouse item not found');
      if (gt(item.avgCost, '0')) {
        throw new BadRequestException(
          'Себестоимость уже задана. Переоценка оценённого остатка — отдельная операция (через закупку/возврат).',
        );
      }
      if (!gt(item.qty, '0')) {
        throw new BadRequestException(
          'Нельзя задать себестоимость для позиции с нулевым остатком — заведите остаток (закупка/начальный остаток).',
        );
      }
      const newCost = roundCost(dto.unitCost);
      if (!gt(newCost, '0')) {
        throw new BadRequestException('Себестоимость должна быть положительной');
      }

      await tx.stockLot.updateMany({
        where: {
          workspaceId,
          warehouseItemId: id,
          qtyRemaining: { gt: 0 },
          deletedAt: null,
          unitCost: 0,
        },
        data: { unitCost: newCost },
      });
      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: id,
          type: 'ADJUSTMENT',
          qtyDelta: D(0),
          qtyAfter: item.qty,
          unitCost: newCost,
          reason: dto.reason ?? 'Установка себестоимости начального остатка',
          refType: 'CostInit',
          createdById: userId,
        },
        tx,
      );
      await this.recomputeCaches(tx, workspaceId, id);
      return this.repo.findById(workspaceId, id, tx);
    });
  }

  // ─────────── Транзакционные методы (используются Purchase / Order) ───────────

  /**
   * Приход на склад при закупке: создаёт партию (StockLot) с трассой (поставщик/
   * счёт/строка закупки) и пишет PURCHASE-движение. ПОД локом строки позиции.
   * `lotMeta.receivedAt` может быть в прошлом (бэкдейт) — допускается, но меняет
   * себестоимость БУДУЩИХ списаний (FIFO-очередь), поэтому логируем предупреждение.
   */
  async applyPurchaseLine(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    addQty: string | Prisma.Decimal,
    addUnitPrice: string | Prisma.Decimal,
    userId: string,
    ref?: { refType?: string; refId?: string },
    lotMeta?: {
      supplierId?: string | null;
      accountId?: string | null;
      purchaseLineId?: string | null;
      receivedAt?: Date;
    },
  ): Promise<void> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);

    const addQ = roundQty(addQty);
    const unitCost = roundCost(addUnitPrice);
    const receivedAt = lotMeta?.receivedAt ?? new Date();

    // Бэкдейт (реш. #3): предупреждаем, если партия встаёт перед уже открытыми
    // (меняет себестоимость будущих списаний). Уже списанное не рекостится.
    if (lotMeta?.receivedAt) {
      const earlier = await tx.stockLot.count({
        where: {
          workspaceId,
          warehouseItemId: itemId,
          qtyRemaining: { gt: 0 },
          deletedAt: null,
          receivedAt: { gt: receivedAt },
        },
      });
      if (earlier > 0) {
        this.logger.warn(
          `Бэкдейт-закупка «${item.name}» (receivedAt=${receivedAt.toISOString()}) встаёт перед ${earlier} открытыми партиями — изменится себестоимость будущих списаний.`,
        );
      }
    }

    await this.repo.createLot(
      {
        workspaceId,
        warehouseItemId: itemId,
        qtyInitial: addQ,
        qtyRemaining: addQ,
        unitCost,
        sourceType: 'PURCHASE',
        sourceId: ref?.refId ?? null,
        purchaseLineId: lotMeta?.purchaseLineId ?? null,
        supplierId: lotMeta?.supplierId ?? null,
        accountId: lotMeta?.accountId ?? null,
        receivedAt,
        createdById: userId,
      },
      tx,
    );
    await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'PURCHASE',
        qtyDelta: addQ,
        qtyAfter: roundQty(add(item.qty, addQ)),
        unitCost,
        refType: ref?.refType ?? 'Purchase',
        refId: ref?.refId ?? null,
        createdById: userId,
      },
      tx,
    );
    await this.recomputeCaches(tx, workspaceId, itemId);
  }

  /**
   * FIFO-списание при продаже/отгрузке (ship/finalize). Списывает партии в порядке
   * поступления, пишет SALE-движение и потребления (с orderItemId — ключ адресного
   * реверса при возврате). Возвращает {qtyConsumed, totalCost}; снимок
   * OrderItem.unitCostAtSale считает order.service из net-леджера.
   */
  async decrementForSale(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    saleQty: string | Prisma.Decimal,
    userId: string,
    ref?: { refType?: string; refId?: string; orderItemId?: string | null },
  ): Promise<ConsumeResult> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);
    const saleQ = roundQty(saleQty);
    try {
      const { totalCost } = await this.consumeLots({
        tx,
        workspaceId,
        itemId,
        cachedQty: item.qty,
        consumeQty: saleQ,
        movementType: 'SALE',
        userId,
        orderItemId: ref?.orderItemId ?? null,
        ref: { refType: ref?.refType ?? 'Order', refId: ref?.refId },
      });
      return { qtyConsumed: saleQ, totalCost };
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        throw new BadRequestException(`«${item.name}»: ${e.message}`);
      }
      throw e;
    }
  }

  /**
   * Адресный реверс возврата клиента / отката финализации: восстанавливает qtyRemaining
   * ИМЕННО тех партий, из которых ушёл товар по строке заказа (LIFO потреблений), по их
   * СНИМОЧНОЙ себестоимости. ПОД локом строки. Если потреблений нет (до-миграционный
   * заказ / удалённая позиция) — бросает NoConsumptionsError (вызывающий идёт в restock).
   */
  async reverseConsumption(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    orderItemId: string,
    returnQty: string | Prisma.Decimal,
    userId: string,
    ref?: { refType?: string; refId?: string },
  ): Promise<{ restored: Prisma.Decimal; restoredCost: Prisma.Decimal }> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) throw new NoConsumptionsError(); // позиция удалена → fallback restock

    const reqQ = roundQty(returnQty);
    const consumptions = await this.repo.reversibleConsumptionsForOrderItem(
      tx,
      workspaceId,
      orderItemId,
    );
    if (consumptions.length === 0) throw new NoConsumptionsError();

    const plan = reversePlan(consumptions, reqQ);
    const newQty = roundQty(add(item.qty, reqQ));

    const movement = await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'RETURN_CUSTOMER',
        qtyDelta: reqQ,
        qtyAfter: newQty,
        unitCost: weightedUnitCost(plan.totalCost, reqQ),
        refType: ref?.refType ?? 'Order',
        refId: ref?.refId ?? null,
        createdById: userId,
      },
      tx,
    );

    // Текущие остатки затронутых партий (под item-локом читать без отдельного FOR UPDATE).
    const lotIds = Array.from(new Set(plan.steps.map((s) => s.lotId)));
    const lotRows = await tx.stockLot.findMany({
      where: { id: { in: lotIds } },
      select: { id: true, qtyRemaining: true },
    });
    const remainingById = new Map(lotRows.map((l) => [l.id, l.qtyRemaining]));

    for (const step of plan.steps) {
      const before = remainingById.get(step.lotId) ?? D(0);
      const after = roundQty(add(before, step.qty));
      remainingById.set(step.lotId, after);
      await this.repo.updateLotRemaining(step.lotId, after, tx);
      await this.repo.recordConsumption(
        {
          workspaceId,
          lotId: step.lotId,
          movementId: movement.id,
          orderItemId,
          qty: roundQty(step.qty.negated()), // − восстановление
          unitCost: step.unitCost,
          kind: 'REVERSAL',
          reversalOfId: step.consumptionId,
        },
        tx,
      );
    }
    await this.recomputeCaches(tx, workspaceId, itemId);
    return { restored: reqQ, restoredCost: plan.totalCost };
  }

  /**
   * FALLBACK возврата на склад НОВОЙ партией (когда адресного реверса нет: до-
   * миграционные заказы без LotConsumption). Создаёт RETURN_CUSTOMER-партию в хвост
   * FIFO по переданной (снимочной) себестоимости. Если позиция soft-deleted —
   * компенсирующее движение без партии (склад не оприходован) + сигнал.
   */
  async restock(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    returnQty: string | Prisma.Decimal,
    userId: string,
    ref?: { refType?: string; refId?: string },
    unitCost?: Prisma.Decimal | null,
  ): Promise<void> {
    const returnQ = roundQty(returnQty);
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) {
      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: itemId,
          type: 'RETURN_CUSTOMER',
          qtyDelta: returnQ,
          qtyAfter: returnQ, // фактический остаток неизвестен (позиция удалена)
          reason: 'Возврат на удалённую/недоступную позицию — склад не оприходован',
          refType: ref?.refType ?? 'Order',
          refId: ref?.refId ?? null,
          createdById: userId,
        },
        tx,
      );
      return;
    }
    const lotCost = roundCost(unitCost ?? item.avgCost);
    await this.repo.createLot(
      {
        workspaceId,
        warehouseItemId: itemId,
        qtyInitial: returnQ,
        qtyRemaining: returnQ,
        unitCost: lotCost,
        sourceType: 'RETURN_CUSTOMER',
        sourceId: ref?.refId ?? null,
        receivedAt: new Date(),
        createdById: userId,
      },
      tx,
    );
    await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'RETURN_CUSTOMER',
        qtyDelta: returnQ,
        qtyAfter: roundQty(add(item.qty, returnQ)),
        unitCost: lotCost,
        refType: ref?.refType ?? 'Order',
        refId: ref?.refId ?? null,
        createdById: userId,
      },
      tx,
    );
    await this.recomputeCaches(tx, workspaceId, itemId);
  }

  /**
   * Возврат товара поставщику. АТОМАРНО (UoW): FIFO-списание возвращаемого количества
   * (приоритет партий ЭТОГО поставщика, затем spill на остальные FIFO — реш. #1) +
   * RETURN_SUPPLIER-движение + Transaction(INCOME, SUPPLIER_REFUND) на refund.
   *
   * M1 устранён структурно: списываем конкретные партии по их цене, без деления
   * (refund−value)/qty и без clamp avgCost. avgCost-кэш остаётся >=0 by construction.
   * refund попадает в бакет PURCHASES (гасит расход закупок), variance с лотовой
   * стоимостью естественен в cash-basis (реш. #2 блица) — отдельной проводки нет.
   */
  async supplierReturn(
    workspaceId: string,
    itemId: string,
    userId: string,
    dto: SupplierReturnDto,
  ) {
    return this.uow.run(async (tx) => {
      const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
      if (!item) throw new NotFoundException('Warehouse item not found');

      await this.assertAccount(workspaceId, dto.accountId, tx);
      await this.assertSupplier(workspaceId, dto.supplierId ?? null, tx);

      const returnQty = roundQty(dto.returnQty);
      if (!gt(returnQty, '0')) {
        throw new BadRequestException('returnQty должен быть положительным');
      }
      // Доступность по ИТОГОВОМУ остатку позиции (не по лотам поставщика) — реш. #1:
      // при достаточном item.qty не блокируем (нет ложного 400 на мультипоставщиковом стоке).
      if (gt(returnQty, item.qty)) {
        const err = new InsufficientStockError(item.qty, returnQty);
        throw new BadRequestException(`«${item.name}»: ${err.message}`);
      }
      const refund = money(dto.refundAmount);

      const txReturn = await tx.transaction.create({
        data: {
          workspaceId,
          date: dto.date ? new Date(dto.date) : new Date(),
          amount: refund,
          type: 'INCOME',
          kind: 'SUPPLIER_REFUND',
          accountId: dto.accountId,
          counterpartyId: dto.supplierId ?? item.defaultSupplierId ?? null,
          description: dto.note ?? `Возврат поставщику: ${item.name}`,
          createdById: userId,
        },
      });

      // Приоритет партий поставщика, затем остальные (обе подгруппы — в FIFO-порядке).
      const lots = await this.repo.lockOpenLots(tx, workspaceId, itemId);
      const ordered = dto.supplierId
        ? [
            ...lots.filter((l) => l.supplierId === dto.supplierId),
            ...lots.filter((l) => l.supplierId !== dto.supplierId),
          ]
        : lots;

      try {
        await this.consumeLots({
          tx,
          workspaceId,
          itemId,
          cachedQty: item.qty,
          consumeQty: returnQty,
          movementType: 'RETURN_SUPPLIER',
          userId,
          orderedLots: ordered,
          ref: { refType: 'Transaction', refId: txReturn.id },
          reason: dto.reason ?? null,
        });
      } catch (e) {
        // Гард returnQty<=item.qty под item-локом + инвариант qty==Σлотов делают это
        // недостижимым в норме; страхуемся на случай рассинхрона кэша/партий — 400, не 500.
        if (e instanceof InsufficientStockError) {
          throw new BadRequestException(`«${item.name}»: ${e.message}`);
        }
        throw e;
      }

      return this.repo.findById(workspaceId, itemId, tx);
    });
  }

  /**
   * Снимок себестоимости строки заказа из net-леджера потреблений: netCost/netQty
   * (округлённый до 4 знаков), либо null если нетто-количество <= 0 (всё возвращено).
   * Единственный источник OrderItem.unitCostAtSale для складских позиций — убирает
   * дрейф старого weightedCost и гарантирует margin == FIFO-COGS (I8). Читается в той
   * же UoW под уже удержанным локом строки позиции.
   */
  async unitCostAtSaleFor(
    tx: TxClient,
    workspaceId: string,
    orderItemId: string,
  ): Promise<Prisma.Decimal | null> {
    const net = await this.repo.netConsumedForOrderItem(tx, workspaceId, orderItemId);
    if (!gt(net.qty, '0')) return null;
    return roundCost(net.cost.div(net.qty));
  }

  /** Список движений позиции (журнал StockMovement), новые сверху. */
  async listMovements(workspaceId: string, itemId: string) {
    await this.get(workspaceId, itemId);
    return this.repo.listMovements(workspaceId, itemId);
  }

  /** Позиции ниже точки дозаказа (reorderPoint задан и qty <= reorderPoint). */
  lowStock(workspaceId: string) {
    return this.repo.lowStock(workspaceId);
  }

  // ─────────── Excel-импорт склада (B2) ───────────

  /**
   * Превью импорта: парсим xlsx, маппим колонки, классифицируем строки на
   * created / skipped (дедуп по name, workspace-scoped). Ничего не пишем в БД.
   */
  async importPreview(
    workspaceId: string,
    buffer: Buffer,
    mapping: WarehouseImportMapping,
  ): Promise<WarehouseImportPreview> {
    const parsed = await parseGenericXlsx(buffer);
    const rows = this.mapImportRows(parsed.rows, mapping);

    const names = Array.from(new Set(rows.map((r) => r.name)));
    const existing =
      names.length > 0 ? await this.repo.findByNames(workspaceId, names) : [];
    const existingLc = new Set(existing.map((e) => e.name.trim().toLowerCase()));

    const seenLc = new Set<string>();
    const created: WarehouseImportRow[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const r of rows) {
      const lc = r.name.trim().toLowerCase();
      if (existingLc.has(lc)) {
        skipped.push({ name: r.name, reason: 'exists' });
      } else if (seenLc.has(lc)) {
        skipped.push({ name: r.name, reason: 'duplicate-in-file' });
      } else {
        seenLc.add(lc);
        created.push(r);
      }
    }

    return {
      headers: parsed.headers,
      created,
      skipped,
      stats: { total: rows.length, created: created.length, skipped: skipped.length },
    };
  }

  /**
   * Коммит импорта склада. На каждую НЕсуществующую позицию (дедуп по name):
   * WarehouseItem + (если qty>0) OPENING-партия + OPENING-движение, затем пересчёт
   * кэшей. Начальные остатки НЕ создают Transaction (cash-basis). Всё в одной UoW.
   */
  async importCommit(
    workspaceId: string,
    userId: string,
    rows: WarehouseImportRow[],
  ): Promise<{ created: number; skipped: number }> {
    return this.uow.run(async (tx) => {
      const names = Array.from(new Set(rows.map((r) => r.name.trim())));
      const existing = await this.repo.findByNames(workspaceId, names, tx);
      const existingLc = new Set(existing.map((e) => e.name.trim().toLowerCase()));

      const seenLc = new Set<string>();
      let created = 0;
      let skipped = 0;
      for (const r of rows) {
        const lc = r.name.trim().toLowerCase();
        if (existingLc.has(lc) || seenLc.has(lc)) {
          skipped++;
          continue;
        }
        seenLc.add(lc);

        const itemQty = roundQty(r.qty ?? '0');
        const item = await this.repo.create(
          {
            workspace: { connect: { id: workspaceId } },
            name: r.name,
            unit: r.unit ?? 'шт',
            qty: D(0),
            avgCost: D(0),
            reorderPoint: r.reorderPoint != null ? roundQty(r.reorderPoint) : null,
          },
          tx,
        );
        if (gt(itemQty, '0')) {
          await this.openingLot(tx, workspaceId, item.id, itemQty, roundCost(r.avgCost ?? '0'), userId);
          await this.recomputeCaches(tx, workspaceId, item.id);
        }
        created++;
      }
      return { created, skipped };
    });
  }

  /** Достаём поля склада из распарсенных строк по маппингу колонок. */
  private mapImportRows(
    parsedRows: Array<{ raw: Record<string, string> }>,
    mapping: WarehouseImportMapping,
  ): WarehouseImportRow[] {
    const out: WarehouseImportRow[] = [];
    for (const pr of parsedRows) {
      const name = (pr.raw[mapping.name] ?? '').trim();
      if (!name) continue;
      out.push({
        name: name.slice(0, 200),
        qty: this.normNumber(mapping.qty ? pr.raw[mapping.qty] : undefined, 3),
        avgCost: this.normNumber(mapping.avgCost ? pr.raw[mapping.avgCost] : undefined, 4),
        unit: mapping.unit ? (pr.raw[mapping.unit] ?? '').trim().slice(0, 16) || undefined : undefined,
        reorderPoint: this.normNumber(
          mapping.reorderPoint ? pr.raw[mapping.reorderPoint] : undefined,
          3,
        ),
      });
    }
    return out;
  }

  /** Нормализация числа из ячейки: запятая→точка, обрезка, null→undefined. */
  private normNumber(raw: string | undefined, places: number): string | undefined {
    if (raw == null) return undefined;
    const cleaned = raw.trim().replace(/\s/g, '').replace(',', '.');
    if (cleaned === '') return undefined;
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
    return D(cleaned).toDecimalPlaces(places).toString();
  }

  /**
   * Стоимость остатков склада = Σ(qtyRemaining × unitCost) по ОТКРЫТЫМ партиям
   * активных позиций (авторитетно из лотов, а не из округлённого avgCost-кэша —
   * без 0.5₽-дрейфа, I5). Архивные/удалённые позиции исключены.
   */
  async stockValue(workspaceId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ total: string }>>`
      SELECT COALESCE(SUM(l."qtyRemaining" * l."unitCost"), 0)::text AS total
      FROM "StockLot" l
      JOIN "WarehouseItem" w ON w."id" = l."warehouseItemId"
      WHERE l."workspaceId" = ${workspaceId}
        AND l."qtyRemaining" > 0
        AND l."deletedAt" IS NULL
        AND w."deletedAt" IS NULL
        AND w."isArchived" = false`;
    return D(rows[0]?.total ?? '0').toFixed(2);
  }
}
