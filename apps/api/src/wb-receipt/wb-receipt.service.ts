import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork, type TxClient } from '../common/unit-of-work';
import { WarehouseService } from '../warehouse/warehouse.service';
import { OrderService } from '../orders/order.service';
import { AuditService } from '../audit/audit.service';
import { add, mul, money, D } from '../common/money';
import { assertNotFuture } from '../reports/period';
import { parseWbReceiptPdf } from './receipt-parser';
import type { CommitWbReceiptDto, WbReceiptLineInput } from './wb-receipt.dto';

/** Окно поиска операции-кандидата под чек (дата чека ± дней). */
const CANDIDATE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/** Имя единого контрагента-посредника (решение блица: «поставщик — ВБ»). */
const WB_COUNTERPARTY_NAME = 'Wildberries';

/**
 * Разбор кассового чека Wildberries (Ф6). Инварианты денег:
 *  - деньги чека = РОВНО ОДНА транзакция-расход: привязанная существующая
 *    операция карты (mode=link, выписка уже импортирована) ИЛИ созданная
 *    разбором (mode=create) — анти-задвоение против импорта выписки;
 *  - Σ строк (включая SKIPPED — деньги ушли за весь чек) == «Итого» чека;
 *  - повторная загрузка чека блокируется по ФПД (partial-unique);
 *  - складские строки приходуются FIFO-партиями (sourceId = WbReceiptLine.id),
 *    заказные — становятся позициями заказа с себестоимостью = цене чека;
 *  - откат — целиком: партии сняты (если не тронуты), позиции убраны (если не
 *    отгружены), созданный расход soft-удалён / привязанный отвязан.
 */
@Injectable()
export class WbReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly warehouse: WarehouseService,
    private readonly orders: OrderService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Превью: разобрать PDF, найти операции-кандидаты для привязки денег
   * (тот же счёт, сумма == итогу чека, дата ± CANDIDATE_WINDOW_DAYS, ещё не
   * занята другим чеком) и проверить повторную загрузку по ФПД.
   * Контракт парсера: непустые warnings — фронт блокирует «Провести», а
   * серверная сверка Σ строк == итогу на commit ловит потерянные позиции.
   */
  async preview(opts: { workspaceId: string; accountId: string; buffer: Buffer }) {
    await this.assertAccount(opts.workspaceId, opts.accountId);
    const parsed = await parseWbReceiptPdf(opts.buffer);

    let candidates: {
      id: string;
      date: Date;
      amount: Prisma.Decimal;
      description: string | null;
    }[] = [];
    if (parsed.totalAmount && parsed.receiptDate) {
      const windowMs = CANDIDATE_WINDOW_DAYS * DAY_MS;
      candidates = await this.prisma.transaction.findMany({
        where: {
          workspaceId: opts.workspaceId,
          accountId: opts.accountId,
          deletedAt: null,
          type: 'EXPENSE',
          kind: 'OTHER',
          transferGroupId: null,
          amount: new Prisma.Decimal(parsed.totalAmount),
          date: {
            gte: new Date(parsed.receiptDate.getTime() - windowMs),
            lte: new Date(parsed.receiptDate.getTime() + windowMs),
          },
          wbReceipt: null, // ещё не деньги другого чека
        },
        select: { id: true, date: true, amount: true, description: true },
        orderBy: { date: 'asc' },
        take: 5,
      });
    }

    const existing = parsed.fpd
      ? await this.prisma.wbReceipt.findFirst({
          where: { workspaceId: opts.workspaceId, fpd: parsed.fpd, deletedAt: null },
          select: { id: true, createdAt: true },
        })
      : null;

    return {
      receipt: {
        ...parsed,
        receiptDate: parsed.receiptDate ? parsed.receiptDate.toISOString() : null,
      },
      candidates: candidates.map((c) => ({
        id: c.id,
        date: c.date.toISOString(),
        amount: c.amount.toFixed(2),
        description: c.description,
      })),
      alreadyImported: existing
        ? { receiptId: existing.id, importedAt: existing.createdAt.toISOString() }
        : null,
    };
  }

  /**
   * Провести разбор чека АТОМАРНО: деньги (создать/привязать) + чек + строки +
   * склад/заказы. Порядок локов согласован с ship/finalize: сначала заказы
   * (sorted by id), затем товары склада (sorted by id) — анти-deadlock.
   */
  async commit(workspaceId: string, userId: string, dto: CommitWbReceiptDto) {
    // Деньги ушли за ВЕСЬ чек, включая пропущенные оператором строки — сумма
    // обязана сходиться с итогом (это же ловит потерянные парсером позиции).
    const linesTotal = dto.lines.reduce(
      (acc, l) => add(acc, mul(l.qty, l.unitPrice)),
      D(0),
    );
    if (!money(linesTotal).equals(money(dto.totalAmount))) {
      throw new BadRequestException(
        `Сумма строк ${money(linesTotal).toFixed(2)} не сходится с итогом чека ${money(
          dto.totalAmount,
        ).toFixed(2)} — проверьте разметку (возможно, часть позиций не распознана)`,
      );
    }
    const receiptDate = new Date(dto.receiptDate);
    assertNotFuture(receiptDate, 'Дата чека');

    // Внешние refs до tx (cross-tenant): счёт, категория расхода.
    await this.assertAccount(workspaceId, dto.accountId);
    if (dto.money.mode === 'create' && dto.money.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: {
          id: dto.money.categoryId,
          workspaceId,
          deletedAt: null,
          kind: 'EXPENSE',
        },
        select: { id: true },
      });
      if (!cat) {
        throw new BadRequestException('Категория не найдена или не расходная');
      }
    }
    // Существующие товары складских строк — принадлежность workspace.
    const itemIds = dto.lines
      .filter((l) => l.target === 'WAREHOUSE')
      .map((l) => (l.target === 'WAREHOUSE' ? l.warehouseItemId : undefined))
      .filter((x): x is string => !!x);
    if (itemIds.length > 0) {
      const found = await this.prisma.warehouseItem.count({
        where: { id: { in: [...new Set(itemIds)] }, workspaceId, deletedAt: null },
      });
      if (found !== new Set(itemIds).size) {
        throw new BadRequestException('Товар склада не найден в этом пространстве');
      }
    }

    return this.uow.run(async (tx) => {
      // Идемпотентность: читаемый отказ до вставки; гонка добьётся P2002 ниже.
      const dup = await tx.wbReceipt.findFirst({
        where: { workspaceId, fpd: dto.fpd, deletedAt: null },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(
          'Этот чек уже разобран (совпал фискальный признак). Откатите прежний разбор, чтобы повторить.',
        );
      }

      const wb = await this.ensureWbCounterparty(tx, workspaceId);

      // Деньги: ровно одна транзакция на чек.
      let transactionId: string;
      let transactionCreated: boolean;
      if (dto.money.mode === 'link') {
        const t = await tx.transaction.findFirst({
          where: { id: dto.money.transactionId, workspaceId, deletedAt: null },
          select: {
            id: true,
            type: true,
            kind: true,
            accountId: true,
            amount: true,
            transferGroupId: true,
            wbReceipt: { select: { id: true } },
          },
        });
        if (!t) throw new NotFoundException('Операция для привязки не найдена');
        if (t.accountId !== dto.accountId) {
          throw new BadRequestException('Операция принадлежит другому счёту');
        }
        if (t.type !== 'EXPENSE' || t.kind !== 'OTHER' || t.transferGroupId) {
          throw new BadRequestException(
            'К чеку можно привязать только обычный расход (не перевод и не системную операцию)',
          );
        }
        if (t.wbReceipt) {
          throw new ConflictException('Операция уже привязана к другому чеку');
        }
        // v1 строго: частичная оплата баллами WB (сумма операции < итога чека)
        // не поддержана — такой чек вносится вручную.
        if (!t.amount.equals(money(dto.totalAmount))) {
          throw new BadRequestException(
            `Сумма операции ${t.amount.toFixed(2)} не равна итогу чека ${money(
              dto.totalAmount,
            ).toFixed(2)} — привязка невозможна`,
          );
        }
        transactionId = t.id;
        transactionCreated = false;
      } else {
        const created = await tx.transaction.create({
          data: {
            workspaceId,
            accountId: dto.accountId,
            date: receiptDate,
            amount: money(dto.totalAmount),
            type: 'EXPENSE',
            kind: 'OTHER',
            categoryId: dto.money.categoryId ?? null,
            counterpartyId: wb.id,
            description: `Чек WB${dto.checkNumber ? ` №${dto.checkNumber}` : ''}`,
            createdById: userId,
          },
          select: { id: true },
        });
        transactionId = created.id;
        transactionCreated = true;
      }

      let receipt: { id: string };
      try {
        receipt = await tx.wbReceipt.create({
          data: {
            workspaceId,
            accountId: dto.accountId,
            transactionId,
            transactionCreated,
            fpd: dto.fpd,
            fd: dto.fd ?? null,
            checkNumber: dto.checkNumber ?? null,
            receiptDate,
            totalAmount: money(dto.totalAmount),
            note: dto.note ?? null,
            createdById: userId,
          },
          select: { id: true },
        });
      } catch (e) {
        // Гонка двух commit одного чека: partial-unique (workspaceId, fpd).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('Этот чек уже разобран (совпал фискальный признак)');
        }
        throw e;
      }

      // Новые товары складских строк — создаём до прихода партий.
      const newItemIdByLineIdx = new Map<number, string>();
      for (const [idx, line] of dto.lines.entries()) {
        if (line.target === 'WAREHOUSE' && line.newItem) {
          const item = await tx.warehouseItem.create({
            data: {
              workspaceId,
              name: line.newItem.name,
              unit: line.newItem.unit,
              qty: D(0),
              avgCost: D(0),
            },
            select: { id: true },
          });
          newItemIdByLineIdx.set(idx, item.id);
        }
      }

      // Заказные строки: группировка по заказу, лок заказов в сортированном
      // порядке; позиция получает себестоимость = цене чека, продажную цену —
      // salePrice (или цену чека по умолчанию).
      const orderGroups = new Map<string, { idx: number; line: WbReceiptLineInput }[]>();
      for (const [idx, line] of dto.lines.entries()) {
        if (line.target === 'ORDER') {
          const group = orderGroups.get(line.orderId) ?? [];
          group.push({ idx, line });
          orderGroups.set(line.orderId, group);
        }
      }
      const orderItemIdByLineIdx = new Map<number, string>();
      for (const orderId of [...orderGroups.keys()].sort()) {
        const group = orderGroups.get(orderId) ?? [];
        const created = await this.orders.addExternalItems(
          tx,
          workspaceId,
          orderId,
          group.map(({ line }) => ({
            name: line.name,
            qty: line.qty,
            unitPrice: line.target === 'ORDER' && line.salePrice ? line.salePrice : line.unitPrice,
            unitCost: line.unitPrice,
          })),
        );
        group.forEach(({ idx }, i) => {
          const row = created[i];
          if (row) orderItemIdByLineIdx.set(idx, row.id);
        });
      }

      // Строки чека (все, включая SKIPPED — форензика полного состава).
      const lineIdByIdx = new Map<number, string>();
      for (const [idx, line] of dto.lines.entries()) {
        const warehouseItemId =
          line.target === 'WAREHOUSE'
            ? (line.warehouseItemId ?? newItemIdByLineIdx.get(idx) ?? null)
            : null;
        const row = await tx.wbReceiptLine.create({
          data: {
            receiptId: receipt.id,
            name: line.name,
            qty: new Prisma.Decimal(line.qty),
            unitPrice: new Prisma.Decimal(line.unitPrice),
            lineTotal: money(mul(line.qty, line.unitPrice)),
            sellerName: line.sellerName ?? null,
            sellerInn: line.sellerInn ?? null,
            wbOrderHash: line.wbOrderHash ?? null,
            target: line.target,
            warehouseItemId,
            orderId: line.target === 'ORDER' ? line.orderId : null,
            orderItemId: orderItemIdByLineIdx.get(idx) ?? null,
          },
          select: { id: true, warehouseItemId: true },
        });
        lineIdByIdx.set(idx, row.id);
      }

      // Приход складских партий — лок товаров в сортированном порядке.
      const warehouseLines = dto.lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line.target === 'WAREHOUSE')
        .map(({ line, idx }) => ({
          idx,
          qty: line.qty,
          unitPrice: line.unitPrice,
          itemId:
            (line.target === 'WAREHOUSE' ? line.warehouseItemId : undefined) ??
            newItemIdByLineIdx.get(idx) ??
            '',
        }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId));
      for (const wl of warehouseLines) {
        await this.warehouse.applyPurchaseLine(
          tx,
          workspaceId,
          wl.itemId,
          wl.qty,
          wl.unitPrice,
          userId,
          { refType: 'WbReceiptLine', refId: lineIdByIdx.get(wl.idx) },
          {
            supplierId: wb.id,
            accountId: dto.accountId,
            purchaseLineId: null,
            receivedAt: receiptDate,
          },
        );
      }

      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'wbReceipt.commit',
        entityType: 'WbReceipt',
        entityId: receipt.id,
        diff: {
          fpd: dto.fpd,
          totalAmount: money(dto.totalAmount).toFixed(2),
          moneyMode: dto.money.mode,
          lines: dto.lines.length,
          toWarehouse: warehouseLines.length,
          toOrders: orderItemIdByLineIdx.size,
        },
      });

      return tx.wbReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: {
          account: { select: { id: true, name: true } },
          transaction: { select: { id: true, date: true, amount: true, description: true } },
          lines: true,
        },
      });
    });
  }

  /**
   * Откат разбора целиком: партии складских строк сняты (если не тронуты),
   * позиции заказов удалены (если не отгружены/не возвращены, заказ открыт),
   * созданный расход soft-удалён, привязанный — отвязан. Чек — soft-delete
   * с обнулением transactionId (иначе unique держал бы операцию занятой).
   */
  async revert(workspaceId: string, receiptId: string, userId: string) {
    return this.uow.run(async (tx) => {
      const receipt = await tx.wbReceipt.findFirst({
        where: { id: receiptId, workspaceId, deletedAt: null },
        include: { lines: true },
      });
      if (!receipt) {
        throw new NotFoundException('Разбор чека не найден или уже отменён');
      }

      // Заказы — в сортированном порядке (анти-deadlock, как commit).
      const byOrder = new Map<string, string[]>();
      for (const line of receipt.lines) {
        if (line.target === 'ORDER' && line.orderId && line.orderItemId) {
          const list = byOrder.get(line.orderId) ?? [];
          list.push(line.orderItemId);
          byOrder.set(line.orderId, list);
        }
      }
      for (const orderId of [...byOrder.keys()].sort()) {
        await this.orders.removeExternalItems(
          tx,
          workspaceId,
          orderId,
          byOrder.get(orderId) ?? [],
        );
      }

      // Склад: снять партии по sourceId = id складских строк.
      const warehouseLines = receipt.lines.filter(
        (l) => l.target === 'WAREHOUSE' && l.warehouseItemId,
      );
      if (warehouseLines.length > 0) {
        await this.warehouse.voidLotsBySource(
          tx,
          workspaceId,
          warehouseLines.map((l) => l.id),
          [...new Set(warehouseLines.map((l) => l.warehouseItemId as string))].sort(),
          userId,
        );
      }

      // Деньги: созданный расход — soft-delete; привязанный — только отвязка.
      if (receipt.transactionId && receipt.transactionCreated) {
        await tx.transaction.update({
          where: { id: receipt.transactionId },
          data: { deletedAt: new Date() },
        });
      }
      await tx.wbReceipt.update({
        where: { id: receiptId },
        data: { deletedAt: new Date(), transactionId: null },
      });

      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'wbReceipt.revert',
        entityType: 'WbReceipt',
        entityId: receiptId,
        diff: {
          fpd: receipt.fpd,
          totalAmount: receipt.totalAmount.toFixed(2),
          transactionCreated: receipt.transactionCreated,
          lines: receipt.lines.length,
        },
      });

      return { reverted: receipt.lines.length };
    });
  }

  /** История разборов (для списка и отката). */
  list(workspaceId: string) {
    return this.prisma.wbReceipt.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        fpd: true,
        checkNumber: true,
        receiptDate: true,
        totalAmount: true,
        transactionCreated: true,
        createdAt: true,
        deletedAt: true,
        account: { select: { id: true, name: true } },
        transaction: { select: { id: true, date: true, amount: true } },
        createdBy: { select: { firstName: true, username: true } },
        _count: { select: { lines: true } },
      },
    });
  }

  /** Единый контрагент-посредник «Wildberries» (find-or-create, insensitive). */
  private async ensureWbCounterparty(
    tx: TxClient,
    workspaceId: string,
  ): Promise<{ id: string }> {
    const existing = await tx.counterparty.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        name: { equals: WB_COUNTERPARTY_NAME, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) return existing;
    return tx.counterparty.create({
      data: { workspaceId, name: WB_COUNTERPARTY_NAME },
      select: { id: true },
    });
  }

  private async assertAccount(workspaceId: string, accountId: string) {
    const acc = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw new NotFoundException('Счёт не найден в этом пространстве');
  }
}
