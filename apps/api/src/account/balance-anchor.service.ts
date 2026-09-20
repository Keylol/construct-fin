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
 * Движения — то, что по счёту УЖЕ в книге (денежные проводки), плюс то, что
 * в неё ещё придёт (строки выписки на разборе). Неразобранное не прячется:
 * NEW-строки вычтены заранее. А решения человека якорь уважает: ручная
 * операция без строки (банк потерял 16.08.2026 четыре списания — их завели
 * руками) и строка «не учитывать» — это учёт как он есть, а не «расхождение».
 * Прежний вывод по всем строкам выписки мерил книгу банком, а не книгой, и
 * такие операции становились расхождением навсегда.
 *
 * Три правила устойчивости — чтобы начальный остаток не двигал отчёты за прошлое:
 *
 *  1. Якорь из сверки — решение человека (source = CHECK). Банк его не
 *     перезаписывает; снять его можно новой сверкой или ручным вводом остатка.
 *  2. Входящее сальдо выписки — факт банка на дату начала выгрузки. Оно
 *     переписывается только когда меняется само: например, после сдвига
 *     backfillFrom назад сальдо берётся на новую дату.
 *  3. Вывод из текущего остатка («остаток сейчас − движения») делается один
 *     раз, пока якоря ещё нет. Повторять его каждым синком нельзя: остаток
 *     «на сейчас» и строки живут в разном времени, и каждая синхронизация
 *     двигала бы начальный остаток, а с ним — все отчёты за прошлое. Дальше
 *     расхождение с банком показывает UI («по банку» против «по учёту»), а не
 *     молчаливая перезапись.
 *
 * Ненулевой ручной остаток (openingAnchoredAt = null) синк не трогает вовсе:
 * если владелец ввёл число сам, расхождение с банком покажет UI.
 */
export interface AnchorSource {
  /** Остаток по внешнему источнику на момент `at`, со знаком. */
  amount: Prisma.Decimal;
  at: Date;
}

/** Откуда якорь: банк (сальдо выписки либо вывод из остатка) или сверка. */
export type AnchorOrigin = 'BANK' | 'CHECK';

export interface AnchorResult {
  opening: string;
  anchoredAt: Date;
  source: AnchorOrigin;
  /** Изменилось ли значение в БД (равное прежнему не перезаписываем). */
  changed: boolean;
}

type AnchorState = {
  openingBalance: Prisma.Decimal;
  openingAnchoredAt: Date | null;
  openingAnchorSource: string | null;
};

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
   * выгрузки, если провайдер его отдаёт: это факт, а не вывод по формуле, и он
   * не зависит от операций «в пути» между балансом и строками. `source` —
   * текущий остаток; из него якорь выводится только один раз, пока якоря нет.
   */
  async anchorFromBank(
    accountId: string,
    source: AnchorSource | null,
    exactOpening: { amount: Prisma.Decimal; date: Date } | null,
  ): Promise<AnchorResult | null> {
    const account = await this.load(accountId);
    if (!account) return null;
    if (account.openingAnchoredAt === null && !account.openingBalance.isZero()) {
      this.logger.log(`Счёт ${accountId}: начальный остаток введён руками — якорь банка не применяем`);
      return null;
    }
    if (account.openingAnchorSource === 'CHECK') {
      this.logger.log(`Счёт ${accountId}: якорь принят из сверки — банк его не перезаписывает`);
      return null;
    }
    if (exactOpening) {
      return this.write(accountId, money(exactOpening.amount), exactOpening.date, 'BANK', account);
    }
    if (!source) return null;
    // Правило 3: выведенный из остатка якорь уже стоит — второй раз не выводим.
    if (account.openingAnchoredAt !== null) return null;
    const net = await this.booksNetUpTo(accountId, source.at);
    return this.write(accountId, deriveOpening(source.amount, net), source.at, 'BANK', account);
  }

  /**
   * Якорь из сверки (явное действие владельца) — перезаписывает любой прежний,
   * включая банковский и ручной: человек только что сверил факт с книгой.
   */
  async anchorFromCheck(accountId: string, source: AnchorSource): Promise<AnchorResult | null> {
    const account = await this.load(accountId);
    if (!account) return null;
    const net = await this.booksNetUpTo(accountId, source.at);
    return this.write(accountId, deriveOpening(source.amount, net), source.at, 'CHECK', account);
  }

  /**
   * Σ движений счёта до момента: денежные проводки (то, что в книге) плюс строки
   * выписки на разборе (то, что в неё ещё придёт). У счёта без выписки (наличные)
   * второе слагаемое пустое, и формула сводится к проводкам.
   */
  async booksNetUpTo(accountId: string, upTo: Date): Promise<Prisma.Decimal> {
    const [ledger, pending] = await Promise.all([
      this.ledgerNetUpTo(accountId, upTo),
      this.pendingLinesNetUpTo(accountId, upTo),
    ]);
    return ledger.plus(pending);
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

  /**
   * Σ строк выписки на разборе (NEW) до момента, по всем живым подключениям
   * счёта. Проведённые строки уже сидят в проводках, «не учитывать» — вне учёта
   * по решению человека; считать надо только то, что ещё станет проводкой.
   */
  async pendingLinesNetUpTo(accountId: string, upTo: Date): Promise<Prisma.Decimal> {
    const groups = await this.prisma.bankStatementLine.groupBy({
      by: ['direction'],
      where: {
        connection: { accountId, deletedAt: null },
        status: 'NEW',
        date: { lte: upTo },
      },
      _sum: { amount: true },
    });
    const income = groups.find((g) => g.direction === 'INCOME')?._sum.amount ?? new Prisma.Decimal(0);
    const expense =
      groups.find((g) => g.direction === 'EXPENSE')?._sum.amount ?? new Prisma.Decimal(0);
    return income.minus(expense);
  }

  private load(accountId: string): Promise<AnchorState | null> {
    return this.prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { openingBalance: true, openingAnchoredAt: true, openingAnchorSource: true },
    });
  }

  private async write(
    accountId: string,
    opening: Prisma.Decimal,
    at: Date,
    source: AnchorOrigin,
    current: AnchorState,
  ): Promise<AnchorResult> {
    const changed =
      !opening.equals(current.openingBalance) ||
      current.openingAnchoredAt === null ||
      current.openingAnchoredAt.getTime() !== at.getTime() ||
      current.openingAnchorSource !== source;
    if (changed) {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { openingBalance: opening, openingAnchoredAt: at, openingAnchorSource: source },
      });
      this.logger.log(
        `Счёт ${accountId}: начальный остаток выведен из якоря ${source} (${at
          .toISOString()
          .slice(0, 10)})`,
      );
    }
    return { opening: opening.toFixed(2), anchoredAt: at, source, changed };
  }
}
