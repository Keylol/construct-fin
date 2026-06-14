import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { money, toMoneyString } from '../common/money';
import type { CreateBalanceCheckDto } from './reconciliation.dto';

/**
 * Сверка счетов (Полоса D). Пользователь периодически вводит ФАКТИЧЕСКИЙ остаток
 * счёта на дату (AccountBalanceCheck, append-only). Отчёт сверки показывает:
 *  - расчётный остаток по книгам на дату (openingBalance + Σ INCOME − Σ EXPENSE,
 *    все транзакции счёта с date <= asOf, включая ноги переводов — это реальное
 *    движение по счёту, как в per-account cashflow);
 *  - последний факт-снимок (<= asOf) и расхождение книги с фактом на его дату;
 *  - «несведённые» операции — движения после последнего снимка до asOf (их ещё
 *    не подтверждали фактом).
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async createCheck(workspaceId: string, createdById: string, dto: CreateBalanceCheckDto) {
    await this.assertAccount(workspaceId, dto.accountId);
    const check = await this.prisma.accountBalanceCheck.create({
      data: {
        workspaceId,
        accountId: dto.accountId,
        date: new Date(dto.date),
        actualBalance: money(dto.actualBalance),
        note: dto.note ?? null,
        createdById,
      },
    });
    return this.serializeCheck(check);
  }

  async listChecks(workspaceId: string, accountId?: string) {
    // Если фильтруют по счёту — проверяем его принадлежность workspace (404 на
    // чужой/несуществующий, а не молчаливый пустой список). Запрос всё равно
    // scoped по workspaceId, так что утечки нет и без этого — это для ясности.
    if (accountId) await this.assertAccount(workspaceId, accountId);
    const checks = await this.prisma.accountBalanceCheck.findMany({
      where: { workspaceId, ...(accountId ? { accountId } : {}) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return checks.map((c) => this.serializeCheck(c));
  }

  /**
   * Снимок-сверка append-only (нет deletedAt), но ошибочный ввод нужно уметь
   * убрать — это справочная запись, не финансовая операция, поэтому удаляем
   * физически (никаких связанных транзакций у неё нет).
   */
  async deleteCheck(workspaceId: string, id: string) {
    const existing = await this.prisma.accountBalanceCheck.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException('Balance check not found');
    await this.prisma.accountBalanceCheck.delete({ where: { id } });
  }

  async build(workspaceId: string, accountId: string, asOfInput?: string) {
    const account = await this.assertAccount(workspaceId, accountId);
    const asOf = asOfInput ? new Date(asOfInput) : new Date();
    const opening = new Prisma.Decimal(account.openingBalance);

    const computedBalance = await this.computedBalanceAt(workspaceId, accountId, opening, asOf);

    const lastCheck = await this.prisma.accountBalanceCheck.findFirst({
      where: { workspaceId, accountId, date: { lte: asOf } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    let lastCheckOut: {
      id: string;
      date: string;
      actualBalance: string;
      computedBalance: string;
      discrepancy: string;
    } | null = null;
    let since: Date | null = null;

    if (lastCheck) {
      const computedAtCheck = await this.computedBalanceAt(
        workspaceId,
        accountId,
        opening,
        lastCheck.date,
      );
      const actual = new Prisma.Decimal(lastCheck.actualBalance);
      lastCheckOut = {
        id: lastCheck.id,
        date: lastCheck.date.toISOString(),
        actualBalance: toMoneyString(actual),
        computedBalance: toMoneyString(computedAtCheck),
        // discrepancy = факт − книга: >0 книга занижена, <0 завышена, 0 сходится.
        discrepancy: toMoneyString(actual.minus(computedAtCheck)),
      };
      since = lastCheck.date;
    }

    const unreconciled = await this.opsBetween(workspaceId, accountId, since, asOf);

    return {
      accountId: account.id,
      accountName: account.name,
      asOf: asOf.toISOString(),
      openingBalance: toMoneyString(opening),
      computedBalance: toMoneyString(computedBalance),
      lastCheck: lastCheckOut,
      unreconciled,
    };
  }

  private async assertAccount(workspaceId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, workspaceId, deletedAt: null },
      select: { id: true, name: true, openingBalance: true },
    });
    if (!account) throw new NotFoundException('Account not found in this workspace');
    return account;
  }

  /** openingBalance + Σ INCOME − Σ EXPENSE по счёту с date <= asOf. */
  private async computedBalanceAt(
    workspaceId: string,
    accountId: string,
    opening: Prisma.Decimal,
    asOf: Date,
  ): Promise<Prisma.Decimal> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: { workspaceId, accountId, deletedAt: null, date: { lte: asOf } },
      _sum: { amount: true },
    });
    const income =
      groups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const expense =
      groups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    return opening.plus(income).minus(expense);
  }

  /** Операции счёта в интервале (since, asOf]; since=null → с начала. */
  private async opsBetween(
    workspaceId: string,
    accountId: string,
    since: Date | null,
    asOf: Date,
  ) {
    const txs = await this.prisma.transaction.findMany({
      where: {
        workspaceId,
        accountId,
        deletedAt: null,
        date: { ...(since ? { gt: since } : {}), lte: asOf },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { id: true, date: true, type: true, kind: true, amount: true, description: true },
    });

    let net = new Prisma.Decimal(0);
    const operations = txs.map((t) => {
      const amt = new Prisma.Decimal(t.amount);
      net = net.plus(t.type === 'INCOME' ? amt : amt.negated());
      return {
        id: t.id,
        date: t.date.toISOString(),
        type: t.type,
        kind: t.kind,
        amount: toMoneyString(amt),
        description: t.description,
      };
    });

    return {
      since: since ? since.toISOString() : null,
      count: operations.length,
      net: toMoneyString(net),
      operations,
    };
  }

  private serializeCheck(c: {
    id: string;
    accountId: string;
    date: Date;
    actualBalance: Prisma.Decimal;
    note: string | null;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      accountId: c.accountId,
      date: c.date.toISOString(),
      actualBalance: toMoneyString(new Prisma.Decimal(c.actualBalance)),
      note: c.note,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
