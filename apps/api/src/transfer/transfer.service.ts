import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnitOfWork, type TxClient } from '../common/unit-of-work';
import { D, gt, money, toMoneyString } from '../common/money';
import type { CreateTransferDto } from './transfer.dto';

interface TransferRow {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Prisma.Decimal;
  fee: Prisma.Decimal;
  date: Date;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class TransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
  ) {}

  async list(workspaceId: string) {
    const items = await this.prisma.transfer.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
    });
    return items.map(this.serialize);
  }

  /**
   * Атомарно создаёт перевод между двумя своими счетами: запись Transfer + две
   * ноги Transaction с общим transferGroupId (OUT/EXPENSE со счёта-источника,
   * IN/INCOME на счёт-получатель, обе на amount). Если fee>0 — третья
   * транзакция VARIABLE_COST на счёте-источнике (реальный расход, БЕЗ
   * transferGroupId — в P&L остаётся, в консолид. cashflow считается).
   */
  async create(workspaceId: string, createdById: string, input: CreateTransferDto) {
    const amount = money(input.amount);
    const fee = money(input.fee);
    if (!gt(amount, '0')) {
      throw new BadRequestException('amount должен быть положительным');
    }
    if (D(fee).isNegative()) {
      throw new BadRequestException('fee не может быть отрицательным');
    }

    await this.assertAccounts(workspaceId, input.fromAccountId, input.toAccountId);

    const date = new Date(input.date);

    return this.uow.run(async (tx) => {
      const transfer = await tx.transfer.create({
        data: {
          workspaceId,
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          amount,
          fee,
          date,
          note: input.note ?? null,
          createdById,
        },
      });

      // Нога OUT: списание со счёта-источника.
      await tx.transaction.create({
        data: {
          workspaceId,
          date,
          amount,
          type: 'EXPENSE',
          kind: 'TRANSFER_OUT',
          accountId: input.fromAccountId,
          transferGroupId: transfer.id,
          description: input.note ?? null,
          createdById,
        },
      });
      // Нога IN: приход на счёт-получатель.
      await tx.transaction.create({
        data: {
          workspaceId,
          date,
          amount,
          type: 'INCOME',
          kind: 'TRANSFER_IN',
          accountId: input.toAccountId,
          transferGroupId: transfer.id,
          description: input.note ?? null,
          createdById,
        },
      });
      // Комиссия — отдельный реальный расход (НЕ нога перевода).
      if (gt(fee, '0')) {
        await tx.transaction.create({
          data: {
            workspaceId,
            date,
            amount: fee,
            type: 'EXPENSE',
            kind: 'VARIABLE_COST',
            accountId: input.fromAccountId,
            description: `Комиссия за перевод${input.note ? `: ${input.note}` : ''}`,
            createdById,
          },
        });
      }

      return this.serialize(transfer);
    });
  }

  /**
   * Гасит перевод и все его ноги (2 или 3 транзакции) одним soft-delete в одной
   * UoW. Комиссия (VARIABLE_COST) не помечена transferGroupId, поэтому она
   * остаётся; гасим только сам Transfer и его связанные ноги.
   */
  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.transfer.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Transfer not found');

    const now = new Date();
    await this.uow.run(async (tx: TxClient) => {
      await tx.transfer.update({ where: { id }, data: { deletedAt: now } });
      await tx.transaction.updateMany({
        where: { workspaceId, transferGroupId: id, deletedAt: null },
        data: { deletedAt: now },
      });
    });
  }

  private async assertAccounts(workspaceId: string, fromId: string, toId: string) {
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [fromId, toId] }, workspaceId, deletedAt: null },
      select: { id: true },
    });
    const ids = new Set(accounts.map((a) => a.id));
    if (!ids.has(fromId)) throw new BadRequestException('fromAccount not found in this workspace');
    if (!ids.has(toId)) throw new BadRequestException('toAccount not found in this workspace');
  }

  private serialize(t: TransferRow) {
    return {
      id: t.id,
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      amount: toMoneyString(t.amount),
      fee: toMoneyString(t.fee),
      date: t.date.toISOString(),
      note: t.note,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}
