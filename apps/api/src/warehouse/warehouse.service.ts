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
import { D, qty as roundQty, cost as roundCost, money, gt } from '../common/money';
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

@Injectable()
export class WarehouseService {
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

  /**
   * Инвентаризация: выставить остаток вручную. avgCost не трогаем.
   * Пишет StockMovement(ADJUSTMENT) c qtyDelta = newQty − oldQty и reason.
   * Если остаток не изменился — движение не пишем (нет факта).
   */
  async adjust(workspaceId: string, id: string, dto: AdjustStockDto, userId: string) {
    return this.uow.run(async (tx) => {
      const item = await this.repo.lockForUpdate(tx, workspaceId, id);
      if (!item) throw new NotFoundException('Warehouse item not found');
      const newQty = roundQty(dto.newQty);
      const delta = roundQty(newQty.minus(item.qty));
      if (delta.isZero()) {
        return this.repo.findById(workspaceId, id, tx);
      }
      const updated = await this.repo.update(id, { qty: newQty }, tx);
      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: id,
          type: 'ADJUSTMENT',
          qtyDelta: delta,
          qtyAfter: newQty,
          reason: dto.reason ?? null,
          refType: 'Adjust',
          createdById: userId,
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Установка себестоимости начального остатка (корректировка оценки).
   * Только для НЕоценённых позиций (avgCost=0): задаём avgCost, количество НЕ
   * трогаем. Деньги НЕ двигаются — в cash-basis начальный остаток не закупка
   * (нет Transaction). Влияет только на БУДУЩИЕ продажи; уже проданное по 0 не
   * переписывается. Запись в журнал движений (ADJUSTMENT, qtyDelta=0) — аудит.
   *
   * Переоценка УЖЕ оценённого остатка тут запрещена (исказила бы средневзвешенную
   * относительно реальных закупок) — это была бы отдельная, более рискованная операция.
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

      const updated = await this.repo.update(id, { avgCost: newCost }, tx);
      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: id,
          type: 'ADJUSTMENT',
          qtyDelta: roundQty(D(0)),
          qtyAfter: item.qty,
          unitCost: newCost,
          reason: dto.reason ?? 'Установка себестоимости начального остатка',
          refType: 'CostInit',
          createdById: userId,
        },
        tx,
      );
      return updated;
    });
  }

  // ─────────── Транзакционные методы (используются Purchase / Order.finalize) ───────────

  /** Приход на склад при закупке: пересчёт WAVG. Должен вызываться внутри UoW. */
  async applyPurchaseLine(
    tx: TxClient,
    workspaceId: string,
    itemId: string,
    addQty: string | Prisma.Decimal,
    addUnitPrice: string | Prisma.Decimal,
    userId: string,
    ref?: { refType?: string; refId?: string },
  ): Promise<void> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);
    const next = applyPurchase(item.qty, item.avgCost, addQty, addUnitPrice);
    await this.repo.update(itemId, { qty: next.qty, avgCost: next.avgCost }, tx);
    await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'PURCHASE',
        qtyDelta: roundQty(addQty),
        qtyAfter: next.qty,
        unitCost: roundCost(addUnitPrice),
        refType: ref?.refType ?? 'Purchase',
        refId: ref?.refId ?? null,
        createdById: userId,
      },
      tx,
    );
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
    userId: string,
    ref?: { refType?: string; refId?: string },
  ): Promise<Prisma.Decimal> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) throw new NotFoundException(`Warehouse item ${itemId} not found`);
    try {
      const { state, unitCost } = applySale(item.qty, item.avgCost, saleQty);
      await this.repo.update(itemId, { qty: state.qty }, tx);
      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: itemId,
          type: 'SALE',
          qtyDelta: roundQty(D(saleQty).negated()),
          qtyAfter: state.qty,
          unitCost,
          refType: ref?.refType ?? 'Order',
          refId: ref?.refId ?? null,
          createdById: userId,
        },
        tx,
      );
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
    userId: string,
    ref?: { refType?: string; refId?: string },
  ): Promise<void> {
    const item = await this.repo.lockForUpdate(tx, workspaceId, itemId);
    if (!item) return; // товар мог быть удалён — молча пропускаем
    const next = applyReturn(item.qty, item.avgCost, returnQty);
    await this.repo.update(itemId, { qty: next.qty }, tx);
    await this.repo.recordMovement(
      {
        workspaceId,
        warehouseItemId: itemId,
        type: 'RETURN_CUSTOMER',
        qtyDelta: roundQty(returnQty),
        qtyAfter: next.qty,
        unitCost: item.avgCost,
        refType: ref?.refType ?? 'Order',
        refId: ref?.refId ?? null,
        createdById: userId,
      },
      tx,
    );
  }

  /**
   * Возврат товара поставщику. АТОМАРНО (UoW):
   *   1. пересчёт qty/avgCost через applySupplierReturn (снимаем returnQty,
   *      общую стоимость уменьшаем на фактический refund);
   *   2. StockMovement(RETURN_SUPPLIER) с отрицательным qtyDelta;
   *   3. транзакция-возврат прихода: поставщик возвращает деньги → приход на
   *      счёт, type=INCOME (уменьшает накопленный расход в cash-basis P&L).
   *
   * kind=SUPPLIER_REFUND (Трек A, A6): возврат поставщику — обратная сторона
   * PURCHASE. Оформляем как Transaction(type=INCOME, kind=SUPPLIER_REFUND) —
   * деньги физически приходят на счёт. В P&L он попадает в бакет PURCHASES
   * (PURCHASES.income), гася PURCHASES.expense → byBucket.PURCHASES показывает
   * ЧИСТЫЕ закупки, а не раздувает «Выручку». Contra-расход отрицательной суммой
   * не делаем — money() запрещает отрицательные. Чистая прибыль и консолид.
   * cashflow корректны (реальный приток денег); margin-отчёты строятся по
   * OrderItem и от этого не зависят.
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

      const returnQty = roundQty(dto.returnQty);
      // B6: returnQty>0 — DTO-regex допускает '0', а нулевой возврат привёл бы к
      // делению на ноль в recordMovement (refund.div(returnQty)).
      if (!gt(returnQty, '0')) {
        throw new BadRequestException('returnQty должен быть положительным');
      }
      if (gt(returnQty, item.qty)) {
        throw new InsufficientStockError(item.qty, returnQty);
      }
      const refund = money(dto.refundAmount);

      const next = applySupplierReturn(item.qty, item.avgCost, returnQty, refund);
      await this.repo.update(itemId, { qty: next.qty, avgCost: next.avgCost }, tx);

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

      await this.repo.recordMovement(
        {
          workspaceId,
          warehouseItemId: itemId,
          type: 'RETURN_SUPPLIER',
          qtyDelta: roundQty(returnQty.negated()),
          qtyAfter: next.qty,
          unitCost: roundCost(refund.div(returnQty)),
          refType: 'Transaction',
          refId: txReturn.id,
          reason: dto.reason ?? null,
          createdById: userId,
        },
        tx,
      );

      return this.repo.findById(workspaceId, itemId, tx);
    });
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

    // Дедуп внутри самого файла: повторное имя в файле тоже пропускаем.
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
   * WarehouseItem(qty, avgCost, unit, reorderPoint) + StockMovement(OPENING).
   * Начальные остатки НЕ создают Transaction (cash-basis). Всё в одной UoW.
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
            qty: itemQty,
            avgCost: roundCost(r.avgCost ?? '0'),
            reorderPoint: r.reorderPoint != null ? roundQty(r.reorderPoint) : null,
          },
          tx,
        );
        await this.repo.recordMovement(
          {
            workspaceId,
            warehouseItemId: item.id,
            type: 'OPENING',
            qtyDelta: itemQty,
            qtyAfter: itemQty,
            unitCost: roundCost(r.avgCost ?? '0'),
            refType: 'Import',
            createdById: userId,
          },
          tx,
        );
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
      if (!name) continue; // строки без имени пропускаем
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

  /** Helper для отчётов: стоимость остатков склада. */
  async stockValue(workspaceId: string): Promise<string> {
    const items = await this.repo.list(workspaceId, { includeArchived: false });
    const total = items.reduce((acc, it) => acc.plus(it.qty.times(it.avgCost)), D(0));
    return total.toFixed(2);
  }
}
