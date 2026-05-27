import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TxClient } from '../common/unit-of-work';
import { WarehouseRepository } from './warehouse.repository';
import { applyPurchase, applySale, applyReturn, InsufficientStockError } from '../common/wavg';
import { D } from '../common/money';
import type {
  CreateWarehouseItemDto,
  UpdateWarehouseItemDto,
  ListWarehouseQuery,
  AdjustStockDto,
} from './warehouse.dto';

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: WarehouseRepository,
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

  /** Helper для отчётов: стоимость остатков склада. */
  async stockValue(workspaceId: string): Promise<string> {
    const items = await this.repo.list(workspaceId, { includeArchived: false });
    const total = items.reduce((acc, it) => acc.plus(it.qty.times(it.avgCost)), D(0));
    return total.toFixed(2);
  }
}
