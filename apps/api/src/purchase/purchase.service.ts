import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork } from '../common/unit-of-work';
import { WarehouseService } from '../warehouse/warehouse.service';
import { AuditService } from '../audit/audit.service';
import { add, mul, money } from '../common/money';
import type { CreatePurchaseDto, ListPurchasesQuery } from './purchase.dto';

@Injectable()
export class PurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly warehouse: WarehouseService,
    private readonly audit: AuditService,
  ) {}

  list(workspaceId: string, query: ListPurchasesQuery) {
    return this.prisma.purchase.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        transaction: { select: { id: true, date: true, amount: true, accountId: true } },
        lines: {
          include: { warehouseItem: { select: { id: true, name: true, unit: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async get(workspaceId: string, id: string) {
    const p = await this.prisma.purchase.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        supplier: true,
        transaction: true,
        lines: { include: { warehouseItem: true } },
      },
    });
    if (!p) throw new NotFoundException('Purchase not found');
    return p;
  }

  /**
   * Регистрирует закупку АТОМАРНО:
   *   1. Transaction(kind=PURCHASE, type=EXPENSE, amount=Σ lineTotal)
   *   2. Purchase + PurchaseLine[]
   *   3. на каждую строку — приход на склад + пересчёт WAVG
   * Всё в одной транзакции UoW: либо всё, либо ничего.
   */
  async register(workspaceId: string, userId: string, dto: CreatePurchaseDto) {
    const lines = dto.lines.map((l) => ({
      ...l,
      lineTotal: money(mul(l.qty, l.unitPrice)),
    }));
    const totalAmount = money(
      lines.reduce((acc, l) => add(acc, l.lineTotal), new Prisma.Decimal(0)),
    );

    const purchaseDate = dto.date ? new Date(dto.date) : new Date();

    return this.uow.run(async (tx) => {
      // 1. Деньги: списание со счёта.
      const transaction = await tx.transaction.create({
        data: {
          workspaceId,
          date: purchaseDate,
          amount: totalAmount,
          type: 'EXPENSE',
          kind: 'PURCHASE',
          accountId: dto.accountId,
          counterpartyId: dto.supplierId ?? null,
          description: dto.note ?? 'Закупка на склад',
          createdById: userId,
        },
      });

      // 2. Документ закупки + строки.
      const purchase = await tx.purchase.create({
        data: {
          workspaceId,
          transactionId: transaction.id,
          supplierId: dto.supplierId ?? null,
          note: dto.note ?? null,
          lines: {
            create: lines.map((l) => ({
              warehouseItemId: l.warehouseItemId,
              qty: new Prisma.Decimal(l.qty),
              unitPrice: new Prisma.Decimal(l.unitPrice),
              lineTotal: l.lineTotal,
            })),
          },
        },
      });

      // 3. Приход на склад + WAVG.
      for (const l of lines) {
        await this.warehouse.applyPurchaseLine(
          tx,
          workspaceId,
          l.warehouseItemId,
          l.qty,
          l.unitPrice,
          userId,
          { refType: 'Purchase', refId: purchase.id },
        );
      }

      await this.audit.record(tx, {
        workspaceId,
        actorId: userId,
        action: 'purchase.register',
        entityType: 'Purchase',
        entityId: purchase.id,
        diff: {
          totalAmount: totalAmount.toFixed(2),
          supplierId: dto.supplierId ?? null,
          linesCount: lines.length,
        },
      });

      return tx.purchase.findUniqueOrThrow({
        where: { id: purchase.id },
        include: {
          supplier: { select: { id: true, name: true } },
          transaction: true,
          lines: { include: { warehouseItem: { select: { id: true, name: true } } } },
        },
      });
    });
  }
}
