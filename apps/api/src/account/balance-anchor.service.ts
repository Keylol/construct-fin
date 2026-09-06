import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { money } from '../common/money';
import { NON_CASH_FOR_ACCOUNT } from '../common/transaction-kinds';

/**
 * Якорь начального остатка счёта.
 *
 * Стартовых остатков у владельца нет: счета заводились с нулём, а выписка
 * тянется с даты подключения. Отсюда минус на каждом банковском счёте — не
 * потому что денег нет, а потому что «по учёту» = 0 + Σ проведённых операций,
 * и пока приходы лежат во «Входящих», расходы уже проведены правилами.
 *
 * Вместо ввода истории начальный остаток ВЫВОДИТСЯ из якоря — числа, которому
 * можно верить независимо от разбора:
 *
 *   openingBalance = якорь − Σ(движений счёта до момента якоря)
 *
 * где якорь — остаток по банку из API (каждый синк) либо фактический остаток,
 * введённый в сверке и явно принятый как якорь. Движения берутся из СТРОК
 * ВЫПИСКИ (все статусы, включая неразобранные и «не учитывать» — банк их все
 * провёл), а не из проводок: иначе якорь подгонял бы учёт под факт и прятал
 * неразобранное. Только у счёта без строк (наличные) движения = проводки.
 *
 * Синк не трогает ненулевой ручной остаток (openingAnchoredAt = null): если
 * владелец ввёл число сам, расхождение с банком покажет UI, а не молчаливая
 * перезапись. Сверка с флагом «принять как якорь» — явное действие, поэтому
 * перезаписывает всегда.
 */
export interface AnchorSource {
  /** Остаток по внешнему источнику на момент `at`, со знаком. */
  amount: Prisma.Decimal;
  at: Date;
}

export interface AnchorResult {
  opening: string;
  anchoredAt: Date;
  /** Изменилось ли значение в БД (равное прежнему не перезаписываем). */
  changed: boolean;
}

/** Чистая формула вывода: остаток − движения до него. */
export function deriveOpening(anchor: Prisma.Decimal, netMovements: Prisma.Decimal): Prisma.Decimal {
  return money(anchor.minus(netMovements));
}

@Injectable()
export class BalanceAnchorService {
  private readonly logger = new Logger(BalanceAnchorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Якорь из банка (синк). `exactOpening` — входящее сальдо выписки на начало
   * периода, если провайдер его отдаёт: точнее вывода по формуле, потому что
   * не зависит от операций «в пути» между балансом и строками.
   */
  async anchorFromBank(
    accountId: string,
    source: AnchorSource | null,
    exactOpening: { amount: Prisma.Decimal; date: Date } | null,
  ): Promise<AnchorResult | null> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { openingBalance: true, openingAnchoredAt: true },
    });
    if (!account) return null;
    const manual = account.openingAnchoredAt === null && !account.openingBalance.isZero();
    if (manual) {
      this.logger.log(`Счёт ${accountId}: начальный остаток введён руками — якорь банка не применяем`);
      return null;
    }

    if (exactOpening) {
      return this.write(accountId, money(exactOpening.amount), exactOpening.date, account);
    }
    if (!source) return null;
    const { net } = await this.statementNetUpTo(accountId, source.at);
    return this.write(accountId, deriveOpening(source.amount, net), source.at, account);
  }

  /**
   * Якорь из сверки (явное действие владельца): счёт со строками выписки —
   * по строкам до конца дня сверки, без строк (наличные) — по проводкам.
   */
  async anchorFromCheck(accountId: string, source: AnchorSource): Promise<AnchorResult | null> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { openingBalance: true, openingAnchoredAt: true },
    });
    if (!account) return null;
    const lines = await this.statementNetUpTo(accountId, source.at);
    const net = lines.hasLines ? lines.net : await this.ledgerNetUpTo(accountId, source.at);
    return this.write(accountId, deriveOpening(source.amount, net), source.at, account);
  }

  /**
   * Σ строк выписки счёта до момента: INCOME − EXPENSE по всем живым
   * подключениям счёта (API и файловым), любого статуса. `hasLines` — есть ли
   * у счёта строки вообще (по ним решается, по чему считать движения).
   */
  async statementNetUpTo(
    accountId: string,
    upTo: Date,
  ): Promise<{ net: Prisma.Decimal; hasLines: boolean }> {
    const where = { connection: { accountId, deletedAt: null } };
    const [groups, total] = await Promise.all([
      this.prisma.bankStatementLine.groupBy({
        by: ['direction'],
        where: { ...where, date: { lte: upTo } },
        _sum: { amount: true },
      }),
      this.prisma.bankStatementLine.count({ where }),
    ]);
    const income = groups.find((g) => g.direction === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const expense =
      groups.find((g) => g.direction === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    return { net: income.minus(expense), hasLines: total > 0 };
  }

  /** Σ денежных проводок счёта до момента (как в сверке: без COGS/списаний). */
  async ledgerNetUpTo(accountId: string, upTo: Date): Promise<Prisma.Decimal> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: {
        accountId,
        deletedAt: null,
        date: { lte: upTo },
        kind: { notIn: NON_CASH_FOR_ACCOUNT },
      },
      _sum: { amount: true },
    });
    const income = groups.find((g) => g.type === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const expense = groups.find((g) => g.type === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    return income.minus(expense);
  }

  private async write(
    accountId: string,
    opening: Prisma.Decimal,
    at: Date,
    current: { openingBalance: Prisma.Decimal; openingAnchoredAt: Date | null },
  ): Promise<AnchorResult> {
    const changed = !opening.equals(current.openingBalance) || current.openingAnchoredAt === null;
    if (changed) {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { openingBalance: opening, openingAnchoredAt: at },
      });
      this.logger.log(
        `Счёт ${accountId}: начальный остаток выведен из якоря (${at.toISOString().slice(0, 10)})`,
      );
    }
    return { opening: opening.toFixed(2), anchoredAt: at, changed };
  }
}
