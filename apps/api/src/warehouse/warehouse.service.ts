import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork, type TxClient } from '../common/unit-of-work';
import { WarehouseRepository } from './warehouse.repository';
import {
  applyPurchase,
  applySale,
  applyReturn,
  applySupplierReturn,
  InsufficientStockError,
} from '../common/wavg';
import { D, money } from '../common/money';
import { PeriodService } from '../period/period.service';
import { AuditService } from '../audit/audit.service';
import type {
  CreateWarehouseItemDto,
  UpdateWarehouseItemDto,
  ListWarehouseQuery,
  AdjustStockDto,
  SupplierReturnDto,
} from './warehouse.dto';

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: WarehouseRepository,
    private readonly uow: UnitOfWork,
    private readonly periods: PeriodService,
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

  create(workspaceId: string, input: CreateWarehouseItemDto) {
    return this.repo.create({
      workspace: { connect: { id: workspaceId } },
      name: input.name,
      sku: input.sku ?? null,
      unit: input.unit ?? 'шт',
      qty: input.openingQty ? new Prisma.Decimal(input.openingQty) : new Prisma.Decimal(0),
      avgCost: input.openingCost ? new Prisma.Decimal(input.openingCost) : new Prisma.Decimal(0),
      note: input.note ?? null,
      ...(input.defaultSupplierId
        ? { defaultSupplier: { connect: { id: input.defaultSupplierId } } }
        : {}),
    });
  }

  async update(workspaceId: string, id: string, input: UpdateWarehouseItemDto) {
    await this.get(workspaceId, id);
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

  /** Инвентаризация: выставить остаток вручную. avgCost не трогаем. */
  async adjust(workspaceId: string, id: string, dto: AdjustStockDto) {
    await this.get(workspaceId, id);
    return this.repo.update(id, { qty: new Prisma.Decimal(dto.newQty) });
  }

  // ─────────── Транзакционные методы (используются Purchase / Order.finalize) ───────────

  /** Приход на склад при закупке: пересчёт WAVG. Должен вызываться внутри UoW. */
  async applyPurchaseLine(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    addQty: string | Prisma.Decimal,
    addUnitPrice: string | Prisma.Decimal,
  ): Promise<void> {
    const item = await this.repo.findById(workspaceId, itemId, tx);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);
    const next = applyPurchase(item.qty, item.avgCost, addQty, addUnitPrice);
    await this.repo.update(itemId, { qty: next.qty, avgCost: next.avgCost }, tx);
  }

  /**
   * Списание при продаже (finalize заказа). Возвращает себестоимость единицы
   * на момент продажи (snapshot для OrderItem.unitCostAtSale).
   */
  async decrementForSale(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    saleQty: string | Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const item = await this.repo.findById(workspaceId, itemId, tx);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);
    try {
      const { state, unitCost } = applySale(item.qty, item.avgCost, saleQty);
      await this.repo.update(itemId, { qty: state.qty }, tx);
      return unitCost;
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        throw new BadRequestException(`«${item.name}»: ${e.message}`);
      }
      throw e;
    }
  }

  /** Возврат товара на склад (отмена DONE-заказа / возврат клиента). avgCost не меняется. */
  async restock(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    returnQty: string | Prisma.Decimal,
  ): Promise<void> {
    const item = await this.repo.findById(workspaceId, itemId, tx);
    if (!item) return; // товар мог быть удалён — молча пропускаем
    const next = applyReturn(item.qty, item.avgCost, returnQty);
    await this.repo.update(itemId, { qty: next.qty }, tx);
  }

  /**
   * Возврат поставщику АТОМАРНО:
   *   1. Списываем qty со склада, пересчитываем avgCost по формуле
   *      newAvg = (oldTotal − refund) / newQty.
   *   2. Создаём Transaction(INCOME, kind=OTHER) — деньги вернулись на счёт.
   *   3. Аудит-запись.
   * Если qty > остатка — BadRequest, rollback.
   */
  async supplierReturn(
    workspaceId: string,
    itemId: string,
    userId: string,
    dto: SupplierReturnDto,
  ) {
    const item = await this.repo.findById(workspaceId, itemId);
    if (!item) throw new NotFoundException('Warehouse item not found');

    const returnQty = new Prisma.Decimal(dto.qty);
    if (returnQty.lte(0)) {
      throw new BadRequestException('Количество должно быть больше нуля');
    }
    if (returnQty.gt(item.qty)) {
      throw new BadRequestException(
        `«${item.name}»: доступно ${item.qty.toString()}, требуется ${dto.qty}`,
      );
    }

    const refund = money(dto.refundAmount);
    const returnDate = dto.date ? new Date(dto.date) : new Date();
    await this.periods.assertOpenForDate(this.prisma, workspaceId, returnDate);

    return this.uow.run(async (tx) => {
      const next = applySupplierReturn(item.qty, item.avgCost, returnQty, refund);
      await this.repo.update(itemId, { qty: next.qty, avgCost: next.avgCost }, tx);

      const transaction = await tx.transaction.create({
        data: {
          workspaceId,
          date: returnDate,
          amount: refund,
          type: 'INCOME',
          kind: 'OTHER',
          accountId: dto.accountId,
          counterpartyId: dto.supplierId ?? item.defaultSupplierId ?? null,
          description:
            dto.note ?? `Возврат поставщику: ${item.name} (${dto.qty} ${item.unit})`,
          createdById: userId,
        },
      });

      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'warehouse.supplier-return',
        entityType: 'WarehouseItem',
        entityId: itemId,
        diff: {
          itemName: item.name,
          qty: dto.qty,
          refundAmount: refund.toFixed(2),
          transactionId: transaction.id,
        },
      });

      return {
        item: await this.repo.findById(workspaceId, itemId, tx),
        transactionId: transaction.id,
      };
    });
  }

  /** Helper для отчётов: стоимость остатков склада. */
  async stockValue(workspaceId: string): Promise<string> {
    const items = await this.repo.list(workspaceId, { includeArchived: false });
    const total = items.reduce((acc, it) => acc.plus(it.qty.times(it.avgCost)), D(0));
    return total.toFixed(2);
  }
}
