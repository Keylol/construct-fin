import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type {
  CreateTransactionDto,
  UpdateTransactionDto,
  ListTransactionsQuery,
  TransactionSummaryQuery,
} from './transaction.dto';

interface TransactionRow {
  id: string;
  date: Date;
  amount: Prisma.Decimal;
  type: 'INCOME' | 'EXPENSE';
  accountId: string;
  categoryId: string | null;
  counterpartyId: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, query: ListTransactionsQuery) {
    const where: Prisma.TransactionWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.counterpartyId ? { counterpartyId: query.counterpartyId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.minAmount || query.maxAmount
        ? {
            amount: {
              ...(query.minAmount ? { gte: new Prisma.Decimal(query.minAmount) } : {}),
              ...(query.maxAmount ? { lte: new Prisma.Decimal(query.maxAmount) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? { description: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const limit = query.limit;
    const items = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map(this.serialize),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  async getById(workspaceId: string, id: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { attachments: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    return {
      ...this.serialize(tx),
      attachments: tx.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: a.createdAt,
      })),
    };
  }

  async create(workspaceId: string, createdById: string, input: CreateTransactionDto) {
    await this.validateRefs(workspaceId, input);
    const created = await this.prisma.transaction.create({
      data: {
        workspaceId,
        createdById,
        date: new Date(input.date),
        amount: new Prisma.Decimal(input.amount),
        type: input.type,
        accountId: input.accountId,
        categoryId: input.categoryId ?? null,
        counterpartyId: input.counterpartyId ?? null,
        description: input.description ?? null,
      },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, id: string, input: UpdateTransactionDto) {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Transaction not found');

    if (input.accountId || input.categoryId !== undefined || input.counterpartyId !== undefined) {
      await this.validateRefs(workspaceId, {
        accountId: input.accountId ?? existing.accountId,
        categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
        counterpartyId:
          input.counterpartyId === undefined ? existing.counterpartyId : input.counterpartyId,
      });
    }

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        date: input.date ? new Date(input.date) : undefined,
        amount: input.amount !== undefined ? new Prisma.Decimal(input.amount) : undefined,
        type: input.type ?? undefined,
        accountId: input.accountId ?? undefined,
        categoryId: input.categoryId === undefined ? undefined : input.categoryId,
        counterpartyId: input.counterpartyId === undefined ? undefined : input.counterpartyId,
        description: input.description === undefined ? undefined : input.description,
      },
    });
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, id: string, actorId: string | null = null) {
    const existing = await this.prisma.transaction.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Transaction not found');
    await this.prisma.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record(undefined, {
      workspaceId,
      actorId,
      action: 'transaction.delete',
      entityType: 'Transaction',
      entityId: id,
      diff: {
        date: existing.date.toISOString(),
        amount: existing.amount.toFixed(2),
        type: existing.type,
        kind: existing.kind,
      },
    });
  }

  /**
   * Сводка INCOME/EXPENSE/NET за период. Используется в дашборде.
   * Учитывает opening balance счетов отдельно — здесь только движение.
   */
  async summary(workspaceId: string, query: TransactionSummaryQuery) {
    const where: Prisma.TransactionWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const groups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where,
      _sum: { amount: true },
    });
    const income = groups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const expense = groups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    const net = new Prisma.Decimal(income).minus(expense);
    return {
      income: income.toFixed(2),
      expense: expense.toFixed(2),
      net: net.toFixed(2),
    };
  }

  private async validateRefs(
    workspaceId: string,
    refs: { accountId: string; categoryId?: string | null; counterpartyId?: string | null },
  ): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: refs.accountId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new BadRequestException('Account not found in this workspace');

    if (refs.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: refs.categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!cat) throw new BadRequestException('Category not found in this workspace');
    }
    if (refs.counterpartyId) {
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: refs.counterpartyId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!cp) throw new BadRequestException('Counterparty not found in this workspace');
    }
  }

  private serialize(t: TransactionRow) {
    return {
      id: t.id,
      date: t.date.toISOString(),
      amount: t.amount.toFixed(2),
      type: t.type,
      accountId: t.accountId,
      categoryId: t.categoryId,
      counterpartyId: t.counterpartyId,
      description: t.description,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}
