import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AccountClass } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toMoneyString } from '../common/money';
import { NON_CASH_FOR_ACCOUNT } from '../common/transaction-kinds';
import type {
  CreateAccountDto,
  UpdateAccountDto,
  ListAccountsQuery,
} from './account.dto';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, query: ListAccountsQuery) {
    const items = await this.prisma.account.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.includeArchived ? {} : { isArchived: false }),
      },
      orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
    });
    return items.map(this.serialize);
  }

  /**
   * Три числа по каждому счёту вместо одного «остатка», который врёт, пока
   * очередь «Входящих» непуста:
   *   • ledger — «по учёту»: openingBalance + Σ денежных проводок (как сверка
   *     и ОДДС по счёту: без COGS/списаний, переводы — реальное движение);
   *   • bank — «по банку»: остаток из API на последнем синке (null без API);
   *   • unresolved — строки выписки NEW: их деньги уже в банке, но не в учёте;
   *   • discrepancy = bank − ledger − unresolvedNet: что осталось необъяснённым
   *     («не учитывать», ручные проводки без банка, операции в пути).
   * Минус здесь превращается из ошибки учёта в задачу: «разобрать N строк».
   */
  async balances(workspaceId: string) {
    const [accounts, txGroups, connections, newGroups] = await Promise.all([
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, openingBalance: true, openingAnchoredAt: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['accountId', 'type'],
        where: { workspaceId, deletedAt: null, kind: { notIn: NON_CASH_FOR_ACCOUNT } },
        _sum: { amount: true },
      }),
      this.prisma.integrationConnection.findMany({
        where: { workspaceId, deletedAt: null, bankBalance: { not: null } },
        select: { accountId: true, bankBalance: true, bankBalanceAt: true },
        orderBy: { bankBalanceAt: 'desc' },
      }),
      this.prisma.bankStatementLine.groupBy({
        by: ['connectionId', 'direction'],
        where: { workspaceId, status: 'NEW', connection: { deletedAt: null } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    // Строки NEW сгруппированы по подключению — переводим на счёт.
    const connAccount = new Map<string, string>();
    if (newGroups.length > 0) {
      const conns = await this.prisma.integrationConnection.findMany({
        where: { id: { in: [...new Set(newGroups.map((g) => g.connectionId))] } },
        select: { id: true, accountId: true },
      });
      for (const c of conns) connAccount.set(c.id, c.accountId);
    }

    const zero = new Prisma.Decimal(0);
    return accounts.map((a) => {
      let ledger = new Prisma.Decimal(a.openingBalance);
      for (const g of txGroups) {
        if (g.accountId !== a.id) continue;
        const sum = g._sum.amount ?? zero;
        ledger = g.type === 'INCOME' ? ledger.plus(sum) : ledger.minus(sum);
      }
      let unresolvedNet = zero;
      let unresolvedCount = 0;
      for (const g of newGroups) {
        if (connAccount.get(g.connectionId) !== a.id) continue;
        const sum = g._sum.amount ?? zero;
        unresolvedNet = g.direction === 'INCOME' ? unresolvedNet.plus(sum) : unresolvedNet.minus(sum);
        unresolvedCount += g._count._all;
      }
      // Свежайший остаток по банку среди подключений счёта (orderBy desc выше).
      const bank = connections.find((c) => c.accountId === a.id && c.bankBalance !== null) ?? null;
      const bankBalance = bank?.bankBalance ?? null;
      return {
        accountId: a.id,
        ledger: toMoneyString(ledger),
        bank: bankBalance !== null ? toMoneyString(bankBalance) : null,
        bankAt: bank?.bankBalanceAt?.toISOString() ?? null,
        unresolvedCount,
        unresolvedNet: toMoneyString(unresolvedNet),
        discrepancy:
          bankBalance !== null ? toMoneyString(bankBalance.minus(ledger).minus(unresolvedNet)) : null,
        anchoredAt: a.openingAnchoredAt?.toISOString() ?? null,
      };
    });
  }

  async create(workspaceId: string, input: CreateAccountDto) {
    const created = await this.prisma.account.create({
      data: {
        workspaceId,
        name: input.name,
        type: input.type,
        class: input.class,
        openingBalance: new Prisma.Decimal(input.openingBalance),
        note: input.note ?? null,
      },
    });
    return this.serialize(created);
  }

  async update(workspaceId: string, id: string, input: UpdateAccountDto) {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');
    const updated = await this.prisma.account.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        type: input.type ?? undefined,
        class: input.class ?? undefined,
        openingBalance:
          input.openingBalance !== undefined ? new Prisma.Decimal(input.openingBalance) : undefined,
        // Введённое руками число — больше не выведенное: якорь снимаем, синк
        // его не перезапишет (ненулевое ручное значение он не трогает).
        openingAnchoredAt:
          input.openingBalance !== undefined &&
          input.openingBalance !== existing.openingBalance.toFixed(2)
            ? null
            : undefined,
        note: input.note === undefined ? undefined : input.note,
        isArchived: input.isArchived ?? undefined,
      },
    });
    return this.serialize(updated);
  }

  async softDelete(workspaceId: string, id: string) {
    const existing = await this.prisma.account.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');
    // M3: счёт с активными операциями удалять нельзя — иначе транзакции осиротеют
    // (accountId укажет на soft-deleted счёт: cashflow/сверка по счёту теряют их,
    // а summary учитывает → расхождение). Для вывода из обращения — архивирование.
    const txCount = await this.prisma.transaction.count({
      where: { accountId: id, workspaceId, deletedAt: null },
    });
    if (txCount > 0) {
      throw new BadRequestException(
        'Нельзя удалить счёт с операциями — перенесите/удалите их или архивируйте счёт',
      );
    }
    await this.prisma.account.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private serialize(a: {
    id: string;
    name: string;
    type: 'CASH' | 'BANK' | 'OTHER';
    class: AccountClass;
    openingBalance: Prisma.Decimal;
    openingAnchoredAt: Date | null;
    note: string | null;
    isArchived: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      class: a.class,
      openingBalance: a.openingBalance.toFixed(2),
      openingAnchoredAt: a.openingAnchoredAt?.toISOString() ?? null,
      note: a.note,
      isArchived: a.isArchived,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}
