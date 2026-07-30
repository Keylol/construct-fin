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
   * транзакция VARIABLE_COST на счёте-источнике (реальный расход). Комиссия
   * ТОЖЕ помечается transferGroupId перевода — чтобы softDelete погасил её
   * каскадом. В P&L/консолид.cashflow ноги перевода исключаются ПО kind
   * (TRANSFER_IN/OUT), а не по наличию transferGroupId, поэтому комиссия
   * (kind=VARIABLE_COST) остаётся учтённой как реальный расход/отток.
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

    const date = new Date(input.date);

    return this.uow.run(async (tx) => {
      // M7: проверку принадлежности счетов делаем ВНУТРИ транзакции и берём
      // `SELECT … FOR UPDATE` на обе строки Account. Иначе между проверкой вне
      // UoW и вставкой ног есть окно, в котором счёт могут soft-delete
      // (account.softDelete, guard M3) → ноги сядут на удалённый счёт
      // (осиротевшие транзакции, расхождение книга/сверка). Под блокировкой
      // конкурентный softDelete (он делает UPDATE той же строки) ждёт коммита,
      // а если счёт уже удалён — фильтр `deletedAt IS NULL` его не вернёт и
      // перевод будет отклонён. Лок снимается на commit/rollback.
      await this.lockAndAssertAccounts(tx, workspaceId, input.fromAccountId, input.toAccountId);

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
      // Комиссия — реальный расход (НЕ нога перевода по kind), но привязана к
      // transferGroupId перевода, чтобы softDelete погасил её вместе с ним.
      if (gt(fee, '0')) {
        await tx.transaction.create({
          data: {
            workspaceId,
            date,
            amount: fee,
            type: 'EXPENSE',
            kind: 'VARIABLE_COST',
            accountId: input.fromAccountId,
            transferGroupId: transfer.id,
            description: `Комиссия за перевод${input.note ? `: ${input.note}` : ''}`,
            createdById,
          },
        });
      }

      return this.serialize(transfer);
    });
  }

  /**
   * Гасит перевод и все его транзакции (2 ноги + комиссия, если была) одним
   * soft-delete в одной UoW. Все они делят transferGroupId = transfer.id,
   * поэтому updateMany по transferGroupId гасит и комиссию каскадом.
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
      // Строки выписки, подтверждённые как ноги этого перевода, возвращаются на
      // разбор: их проводки только что погашены, и без отвязки строки остались
      // бы «обработанными» со ссылкой на удалённые операции. FK SetNull здесь
      // не спасает — удаление мягкое.
      await tx.bankStatementLine.updateMany({
        where: { workspaceId, transferId: id },
        data: { status: 'NEW', transactionId: null, transferId: null },
      });
    });
  }

  /**
   * Блокирует строки счетов (`SELECT … FOR UPDATE`) внутри транзакции и
   * проверяет, что оба активны и принадлежат workspace. Лок гарантирует, что
   * счёт не будет soft-deleted между проверкой и вставкой ног перевода (M7).
   * `ORDER BY id` задаёт детерминированный порядок захвата блокировок, чтобы
   * два встречных перевода по тем же счетам не словили deadlock.
   */
  private async lockAndAssertAccounts(
    tx: TxClient,
    workspaceId: string,
    fromId: string,
    toId: string,
  ) {
    // #12: архивный счёт (isArchived) — закрытый, на него нельзя проводить
    // перевод. Отсекаем в том же FOR UPDATE-запросе: архивный/удалённый/чужой
    // счёт не попадёт в locked → перевод отклонится с понятной ошибкой ниже.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Account"
      WHERE "id" IN (${fromId}, ${toId})
        AND "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND "isArchived" = false
      ORDER BY "id"
      FOR UPDATE`;
    const ids = new Set(locked.map((a) => a.id));
    if (!ids.has(fromId))
      throw new BadRequestException('fromAccount not found or archived in this workspace');
    if (!ids.has(toId))
      throw new BadRequestException('toAccount not found or archived in this workspace');
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
